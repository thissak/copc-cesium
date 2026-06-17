// PoC (throwaway): pnts 에 per-point BATCH_TABLE(Classification)을 넣으면
// Cesium 이 (1) Cesium3DTileStyle ${Classification} 로 동적 스타일링 (2) scene.pick 으로
// getProperty('Classification') 피킹 조회 — 둘 다 실제로 되는가? (#1 속성 충실도 가설 확정)
import {
  BoundingSphere,
  Cartesian2,
  Cartesian3,
  Cesium3DTileStyle,
  Cesium3DTileset,
  type Viewer,
} from 'cesium';
import { CopcTileset } from './copc-tileset';

/** 합성 점군(POSITION f32 + RGB) + per-point BATCH_TABLE(Classification UNSIGNED_BYTE) → pnts. */
function buildPntsWithClassification(
  positions: Cartesian3[],
  rtc: Cartesian3,
  classification: Uint8Array,
): ArrayBuffer {
  const n = positions.length;
  const posBytes = n * 3 * 4;
  const rgbBytes = n * 3;
  const batchIdBytes = n * 2; // UNSIGNED_SHORT — 점당 feature(피킹) 활성화
  const ftBinLen = posBytes + rgbBytes + batchIdBytes;
  const ftBin = new ArrayBuffer(ftBinLen);
  const pos = new Float32Array(ftBin, 0, n * 3);
  const col = new Uint8Array(ftBin, posBytes, rgbBytes);
  const bid = new Uint16Array(ftBin, posBytes + rgbBytes, n);
  for (let i = 0; i < n; i++) {
    pos[i * 3] = positions[i].x - rtc.x;
    pos[i * 3 + 1] = positions[i].y - rtc.y;
    pos[i * 3 + 2] = positions[i].z - rtc.z;
    col[i * 3] = 200; // base grey — style 가 덮으면 가설 확정
    col[i * 3 + 1] = 200;
    col[i * 3 + 2] = 200;
    bid[i] = i; // 점당 고유 batchId → batch table Classification[batchId]
  }

  const ft = {
    POINTS_LENGTH: n,
    BATCH_LENGTH: n,
    RTC_CENTER: [rtc.x, rtc.y, rtc.z],
    POSITION: { byteOffset: 0 },
    RGB: { byteOffset: posBytes },
    BATCH_ID: { byteOffset: posBytes + rgbBytes, componentType: 'UNSIGNED_SHORT' },
  };
  let ftJSON = JSON.stringify(ft);
  while ((28 + ftJSON.length) % 8 !== 0) ftJSON += ' '; // FT Binary 8B 정렬
  const ftJSONbytes = new TextEncoder().encode(ftJSON);

  // batch table: Classification (BATCH_ID 없음 → 점당 feature, batchId=점 인덱스)
  const btBinLen = n; // UNSIGNED_BYTE x n
  const bt = { Classification: { byteOffset: 0, componentType: 'UNSIGNED_BYTE', type: 'SCALAR' } };
  let btJSON = JSON.stringify(bt);
  while ((28 + ftJSONbytes.length + ftBinLen + btJSON.length) % 8 !== 0) btJSON += ' '; // BT Binary 8B 정렬
  const btJSONbytes = new TextEncoder().encode(btJSON);

  const headerLen = 28;
  const total = headerLen + ftJSONbytes.length + ftBinLen + btJSONbytes.length + btBinLen;
  const padded = Math.ceil(total / 8) * 8;
  const buf = new ArrayBuffer(padded);
  const dv = new DataView(buf);
  const u8 = new Uint8Array(buf);
  dv.setUint8(0, 0x70); dv.setUint8(1, 0x6e); dv.setUint8(2, 0x74); dv.setUint8(3, 0x73); // "pnts"
  dv.setUint32(4, 1, true);
  dv.setUint32(8, padded, true);
  dv.setUint32(12, ftJSONbytes.length, true);
  dv.setUint32(16, ftBinLen, true);
  dv.setUint32(20, btJSONbytes.length, true); // batchTableJSONByteLength
  dv.setUint32(24, btBinLen, true); // batchTableBinaryByteLength
  let off = headerLen;
  u8.set(ftJSONbytes, off); off += ftJSONbytes.length;
  u8.set(new Uint8Array(ftBin), off); off += ftBinLen;
  u8.set(btJSONbytes, off); off += btJSONbytes.length;
  u8.set(classification.subarray(0, n), off);
  return buf;
}

function toB64(buf: ArrayBuffer): string {
  const b = new Uint8Array(buf);
  let s = '';
  const c = 0x8000;
  for (let i = 0; i < b.length; i += c) s += String.fromCharCode(...b.subarray(i, i + c));
  return btoa(s);
}

export async function runSpikeBatch(viewer: Viewer): Promise<void> {
  // 합성 그리드: autzen 부근. 좌반(i<G/2)=class 2, 우반=class 6.
  const lon0 = -123.078;
  const lat0 = 44.056;
  const h = 200;
  const G = 40;
  const positions: Cartesian3[] = [];
  const cls: number[] = [];
  for (let i = 0; i < G; i++) {
    for (let j = 0; j < G; j++) {
      positions.push(Cartesian3.fromDegrees(lon0 + i * 0.0002, lat0 + j * 0.0002, h));
      cls.push(i < G / 2 ? 2 : 6);
    }
  }
  const classification = Uint8Array.from(cls);
  const bs = BoundingSphere.fromPoints(positions);
  const pnts = buildPntsWithClassification(positions, bs.center, classification);
  const tilesetJson = {
    asset: { version: '1.0' },
    geometricError: 1e7,
    root: {
      boundingVolume: { sphere: [bs.center.x, bs.center.y, bs.center.z, bs.radius] },
      geometricError: 0,
      refine: 'ADD',
      content: { uri: 'data:application/octet-stream;base64,' + toB64(pnts) },
    },
  };
  const tilesetUri = 'data:application/json;base64,' + btoa(JSON.stringify(tilesetJson));

  let tileLoaded = 0;
  let tileFailed = 0;
  let failMsg = '';
  const tileset = await Cesium3DTileset.fromUrl(tilesetUri);
  tileset.tileLoad.addEventListener(() => { tileLoaded++; });
  tileset.tileFailed.addEventListener((e: unknown) => {
    tileFailed++;
    failMsg = (e as { message?: string })?.message ?? String(e);
  });
  tileset.pointCloudShading.attenuation = false;
  // 가설①: ${Classification} 로 동적 색·크기
  tileset.style = new Cesium3DTileStyle({
    color: {
      conditions: [
        ['${Classification} === 2', 'color("yellow")'],
        ['${Classification} === 6', 'color("red")'],
        ['true', 'color("white")'],
      ],
    },
    pointSize: '8',
  });
  viewer.scene.primitives.add(tileset);
  await viewer.zoomTo(tileset);
  await new Promise((r) => setTimeout(r, 2500));

  // 가설②: scene.pick → getProperty('Classification') (좌표는 Playwright 에서 호출)
  (window as unknown as { __spikePick: (x: number, y: number) => unknown }).__spikePick = (x, y) => {
    const f = viewer.scene.pick(new Cartesian2(x, y)) as
      | { getProperty?: (n: string) => unknown; constructor?: { name?: string } }
      | undefined;
    if (!f) return { hit: false };
    return {
      hit: true,
      ctor: f.constructor?.name,
      hasGetProperty: typeof f.getProperty === 'function',
      classification: typeof f.getProperty === 'function' ? f.getProperty('Classification') : undefined,
    };
  };
  (window as unknown as { __spikeBatch: unknown }).__spikeBatch = {
    points: positions.length,
    pntsBytes: pnts.byteLength,
    tileLoaded,
    tileFailed,
    failMsg,
    styleApplied: true,
  };
  // eslint-disable-next-line no-console
  console.log('SPIKE_BATCH ' + JSON.stringify({ tileLoaded, tileFailed, failMsg, pntsBytes: pnts.byteLength }));
}

/** 실 파이프라인 검증: CopcTileset.fromUrl(autzen) (기본 큐레이션 속성→batch table) 위에
 *  ${Classification} 동적 스타일 + 피킹이 *우리 실제 buildQuantizedPnts 산출물*에서 되는가. (#1 end-to-end) */
export async function runSpikeReal(viewer: Viewer): Promise<void> {
  const url = 'https://s3.amazonaws.com/hobu-lidar/autzen-classified.copc.laz';
  const tileset = await CopcTileset.fromUrl(url); // 기본 attributes=큐레이션(Classification 등) → batch table
  let tileLoaded = 0;
  let tileFailed = 0;
  tileset.tileLoad.addEventListener(() => { tileLoaded++; });
  tileset.tileFailed.addEventListener(() => { tileFailed++; });
  // 동적 스타일: ground(2)=노랑, building(6)=주황, 그 외=원본 RGB
  tileset.style = new Cesium3DTileStyle({
    color: {
      conditions: [
        ['${Classification} === 2', 'color("yellow")'],
        ['${Classification} === 6', 'color("orange")'],
        ['true', 'color("cyan")'],
      ],
    },
  });
  viewer.scene.primitives.add(tileset);
  await viewer.zoomTo(tileset);
  await new Promise((r) => setTimeout(r, 5000));
  (window as unknown as { __spikePick: (x: number, y: number) => unknown }).__spikePick = (x, y) => {
    const f = viewer.scene.pick(new Cartesian2(x, y)) as
      | { getProperty?: (n: string) => unknown; constructor?: { name?: string } }
      | undefined;
    if (!f) return { hit: false };
    return {
      hit: true,
      ctor: f.constructor?.name,
      classification: typeof f.getProperty === 'function' ? f.getProperty('Classification') : undefined,
      intensity: typeof f.getProperty === 'function' ? f.getProperty('Intensity') : undefined,
    };
  };
  (window as unknown as { __spikeReal: unknown }).__spikeReal = { tileLoaded, tileFailed };
  // eslint-disable-next-line no-console
  console.log('SPIKE_REAL ' + JSON.stringify({ tileLoaded, tileFailed }));
}
