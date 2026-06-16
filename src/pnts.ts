import { Cartesian3 } from 'cesium';

// 3D Tiles 1.0 Point Cloud(.pnts) 타일을 메모리에서 직접 생성한다.
// 스펙: github.com/CesiumGS/3d-tiles PointCloud
// 헤더(28B) + Feature Table JSON + Feature Table Binary(POSITION f32×3, RGB u8×3).
// RTC_CENTER로 점을 중심 상대좌표로 줘서 행성 스케일 정밀도(jitter) 해결.

/** positions·rtcCenter = ECEF(Cartesian3). rgb = 점당 [r,g,b] (0-255) 평탄 Uint8Array. */
export function buildPnts(positions: Cartesian3[], rtcCenter: Cartesian3, rgb: Uint8Array): ArrayBuffer {
  const n = positions.length;
  const posBytes = n * 3 * 4; // float32 x3
  const rgbBytes = n * 3; // uint8 x3
  const ftBinLen = posBytes + rgbBytes;

  const ftBin = new ArrayBuffer(ftBinLen);
  const pos = new Float32Array(ftBin, 0, n * 3);
  const col = new Uint8Array(ftBin, posBytes, rgbBytes);
  for (let i = 0; i < n; i++) {
    pos[i * 3] = positions[i].x - rtcCenter.x;
    pos[i * 3 + 1] = positions[i].y - rtcCenter.y;
    pos[i * 3 + 2] = positions[i].z - rtcCenter.z;
    col[i * 3] = rgb[i * 3];
    col[i * 3 + 1] = rgb[i * 3 + 1];
    col[i * 3 + 2] = rgb[i * 3 + 2];
  }

  const ft = {
    POINTS_LENGTH: n,
    RTC_CENTER: [rtcCenter.x, rtcCenter.y, rtcCenter.z],
    POSITION: { byteOffset: 0 },
    RGB: { byteOffset: posBytes },
  };
  let ftJSON = JSON.stringify(ft);
  // Feature Table Binary 는 타일 시작 기준 8바이트 경계에서 시작해야 함 (헤더 28B + ftJSON 길이) % 8 == 0
  while ((28 + ftJSON.length) % 8 !== 0) ftJSON += ' ';
  const ftJSONbytes = new TextEncoder().encode(ftJSON);

  const headerLen = 28;
  const total = headerLen + ftJSONbytes.length + ftBinLen;
  const padded = Math.ceil(total / 8) * 8; // 타일 byteLength 8바이트 정렬

  const buf = new ArrayBuffer(padded);
  const dv = new DataView(buf);
  const u8 = new Uint8Array(buf);
  // magic "pnts"
  dv.setUint8(0, 0x70);
  dv.setUint8(1, 0x6e);
  dv.setUint8(2, 0x74);
  dv.setUint8(3, 0x73);
  dv.setUint32(4, 1, true); // version
  dv.setUint32(8, padded, true); // byteLength
  dv.setUint32(12, ftJSONbytes.length, true); // featureTableJSONByteLength
  dv.setUint32(16, ftBinLen, true); // featureTableBinaryByteLength
  dv.setUint32(20, 0, true); // batchTableJSONByteLength
  dv.setUint32(24, 0, true); // batchTableBinaryByteLength
  u8.set(ftJSONbytes, headerLen);
  u8.set(new Uint8Array(ftBin), headerLen + ftJSONbytes.length);
  return buf;
}

/** 큰 바이너리도 안전하게 base64 (32KB 청크). */
export function toBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}
