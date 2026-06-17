// Cesium-free pnts 빌더 — Web Worker 전용 (Cesium import 금지).
// lonLatH(평탄 [lon,lat,h,...]) + colors(점당 RGB) → 3D Tiles 1.0 .pnts (POSITION_QUANTIZED).
// 위치를 uint16×3 으로 양자화해 float32 대비 바이트 절반. 정밀도는 per-tile QUANTIZED_VOLUME
// (타일 ECEF extent)에 상대 → 도시 스케일 cm~mm. RTC_CENTER 로 행성 스케일 jitter 해결.
// 스펙: github.com/CesiumGS/3d-tiles PointCloud (POSITION_QUANTIZED + QUANTIZED_VOLUME_*).

import type { AttributeSpec, ComponentType } from './attributes';

export interface BatchData {
  specs: AttributeSpec[];
  values: number[][]; // values[k] parallel to specs[k], length n
}

const CT_BYTES: Record<ComponentType, number> = {
  BYTE: 1, UNSIGNED_BYTE: 1, SHORT: 2, UNSIGNED_SHORT: 2,
  INT: 4, UNSIGNED_INT: 4, FLOAT: 4, DOUBLE: 8,
};
function writeTyped(buf: ArrayBuffer, offset: number, t: ComponentType, vals: number[]): void {
  switch (t) {
    case 'BYTE': new Int8Array(buf, offset, vals.length).set(vals); break;
    case 'UNSIGNED_BYTE': new Uint8Array(buf, offset, vals.length).set(vals); break;
    case 'SHORT': new Int16Array(buf, offset, vals.length).set(vals); break;
    case 'UNSIGNED_SHORT': new Uint16Array(buf, offset, vals.length).set(vals); break;
    case 'INT': new Int32Array(buf, offset, vals.length).set(vals); break;
    case 'UNSIGNED_INT': new Uint32Array(buf, offset, vals.length).set(vals); break;
    case 'FLOAT': new Float32Array(buf, offset, vals.length).set(vals); break;
    case 'DOUBLE': new Float64Array(buf, offset, vals.length).set(vals); break;
  }
}
const align = (x: number, a: number): number => Math.ceil(x / a) * a;

const D2R = Math.PI / 180;
// WGS84 (Cesium Ellipsoid.WGS84 와 동일): a=6378137, 1/f=298.257223563
const A = 6378137.0;
const F = 1 / 298.257223563;
const E2 = F * (2 - F);

/** 경위도+높이(m) → ECEF(m). Cesium Cartesian3.fromDegrees 와 동일한 WGS84 변환. */
function geodeticToEcef(lonDeg: number, latDeg: number, h: number, out: Float64Array, o: number): void {
  const lon = lonDeg * D2R;
  const lat = latDeg * D2R;
  const sinLat = Math.sin(lat);
  const cosLat = Math.cos(lat);
  const n = A / Math.sqrt(1 - E2 * sinLat * sinLat);
  const r = (n + h) * cosLat;
  out[o] = r * Math.cos(lon);
  out[o + 1] = r * Math.sin(lon);
  out[o + 2] = (n * (1 - E2) + h) * sinLat;
}

function quant(t: number): number {
  const v = Math.round(t * 65535);
  return v < 0 ? 0 : v > 65535 ? 65535 : v;
}

/**
 * 노드 점(lonLatH) + 점당 colors(평탄 RGB) → POSITION_QUANTIZED pnts ArrayBuffer.
 * 색 결정은 호출부(colors.ts/decodeNode)에서 끝나 있고, 여기선 위치 양자화 + 패킹만 한다.
 */
export function buildQuantizedPnts(lonLatH: number[], colors: Uint8Array, batch?: BatchData): ArrayBuffer {
  const n = lonLatH.length / 3;

  // 1) ECEF 변환 + bbox
  const ecef = new Float64Array(n * 3);
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < n; i++) {
    geodeticToEcef(lonLatH[i * 3], lonLatH[i * 3 + 1], lonLatH[i * 3 + 2], ecef, i * 3);
    const x = ecef[i * 3], y = ecef[i * 3 + 1], z = ecef[i * 3 + 2];
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
    if (z < minZ) minZ = z;
    if (z > maxZ) maxZ = z;
  }
  if (n === 0) { minX = maxX = minY = maxY = minZ = maxZ = 0; }

  // RTC = bbox 중심. 양자화 볼륨 = RTC 상대(offset = min-center = -extent/2, scale = extent).
  const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2, cz = (minZ + maxZ) / 2;
  const sx = (maxX - minX) || 1, sy = (maxY - minY) || 1, sz = (maxZ - minZ) || 1; // scale 0 가드
  const ox = minX - cx, oy = minY - cy, oz = minZ - cz;

  // 2) 양자화 위치 + 색 + (옵션) BATCH_ID 버퍼
  const posBytes = n * 3 * 2; // uint16 x3
  const rgbBytes = n * 3; // uint8 x3
  const useBatch = !!batch && batch.specs.length > 0 && n > 0;
  const bidType: ComponentType = n > 65535 ? 'UNSIGNED_INT' : 'UNSIGNED_SHORT';
  const bidBytes = useBatch ? n * CT_BYTES[bidType] : 0;
  // BATCH_ID 는 컴포넌트 크기 정렬: posBytes(짝수)+rgbBytes 뒤를 정렬.
  const bidOffset = align(posBytes + rgbBytes, CT_BYTES[bidType]);
  // no-batch 출력은 변경 전과 byte-identical: ftBinLen = posBytes + rgbBytes 그대로.
  const ftBinLen = useBatch ? align(bidOffset + bidBytes, 8) : posBytes + rgbBytes;
  const ftBin = new ArrayBuffer(ftBinLen);
  const q = new Uint16Array(ftBin, 0, n * 3);
  const col = new Uint8Array(ftBin, posBytes, rgbBytes);

  for (let i = 0; i < n; i++) {
    q[i * 3] = quant((ecef[i * 3] - minX) / sx);
    q[i * 3 + 1] = quant((ecef[i * 3 + 1] - minY) / sy);
    q[i * 3 + 2] = quant((ecef[i * 3 + 2] - minZ) / sz);
  }
  col.set(colors.subarray(0, n * 3));
  if (useBatch) {
    const ids = new Array<number>(n);
    for (let i = 0; i < n; i++) ids[i] = i;
    writeTyped(ftBin, bidOffset, bidType, ids);
  }

  // 2b) batch table binary — 속성별 컴포넌트 크기 정렬
  let btBinLen = 0;
  const btProps: Record<string, { byteOffset: number; componentType: ComponentType; type: 'SCALAR' }> = {};
  const btLayout: { offset: number; spec: AttributeSpec; vals: number[] }[] = [];
  if (useBatch) {
    let off = 0;
    for (let k = 0; k < batch!.specs.length; k++) {
      const spec = batch!.specs[k];
      off = align(off, CT_BYTES[spec.componentType]);
      btProps[spec.batchName] = { byteOffset: off, componentType: spec.componentType, type: 'SCALAR' };
      btLayout.push({ offset: off, spec, vals: batch!.values[k] });
      off += n * CT_BYTES[spec.componentType];
    }
    btBinLen = off;
  }
  const btBin = new ArrayBuffer(btBinLen);
  for (const { offset, spec, vals } of btLayout) writeTyped(btBin, offset, spec.componentType, vals);

  // 3) Feature Table JSON
  const ft: Record<string, unknown> = {
    POINTS_LENGTH: n,
    RTC_CENTER: [cx, cy, cz],
    QUANTIZED_VOLUME_OFFSET: [ox, oy, oz],
    QUANTIZED_VOLUME_SCALE: [sx, sy, sz],
    POSITION_QUANTIZED: { byteOffset: 0 },
    RGB: { byteOffset: posBytes },
  };
  if (useBatch) {
    ft.BATCH_LENGTH = n;
    ft.BATCH_ID = { byteOffset: bidOffset, componentType: bidType };
  }
  let ftJSON = JSON.stringify(ft);
  while ((28 + ftJSON.length) % 8 !== 0) ftJSON += ' ';
  const ftJSONbytes = new TextEncoder().encode(ftJSON);

  // Batch Table JSON — 8B 경계에서 BT binary 시작
  let btJSONbytes = new Uint8Array(0);
  if (useBatch) {
    let btJSON = JSON.stringify(btProps);
    while ((28 + ftJSONbytes.length + ftBinLen + btJSON.length) % 8 !== 0) btJSON += ' ';
    btJSONbytes = new TextEncoder().encode(btJSON);
  }

  const headerLen = 28;
  const total = headerLen + ftJSONbytes.length + ftBinLen + btJSONbytes.length + btBinLen;
  const padded = Math.ceil(total / 8) * 8;
  const buf = new ArrayBuffer(padded);
  const dv = new DataView(buf);
  const u8 = new Uint8Array(buf);
  dv.setUint8(0, 0x70); dv.setUint8(1, 0x6e); dv.setUint8(2, 0x74); dv.setUint8(3, 0x73);
  dv.setUint32(4, 1, true);
  dv.setUint32(8, padded, true);
  dv.setUint32(12, ftJSONbytes.length, true);
  dv.setUint32(16, ftBinLen, true);
  dv.setUint32(20, btJSONbytes.length, true);
  dv.setUint32(24, btBinLen, true);
  let w = headerLen;
  u8.set(ftJSONbytes, w); w += ftJSONbytes.length;
  u8.set(new Uint8Array(ftBin), w); w += ftBinLen;
  u8.set(btJSONbytes, w); w += btJSONbytes.length;
  u8.set(new Uint8Array(btBin), w);
  return buf;
}
