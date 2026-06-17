// pnts BATCH_TABLE + BATCH_ID 라운드트립: 빌드한 pnts 를 파싱해 구조·값 검증.
import { buildQuantizedPnts } from '../src/pnts-quantized';
import type { AttributeSpec } from '../src/attributes';

function assert(c: unknown, m: string): void { if (!c) { console.error('FAIL: ' + m); process.exit(1); } }

// 2점, lon/lat/h
const lonLatH = [-123.07, 44.06, 100, -123.071, 44.061, 110];
const colors = new Uint8Array([255, 0, 0, 0, 255, 0]);
const specs: AttributeSpec[] = [
  { lasName: 'Classification', batchName: 'Classification', componentType: 'UNSIGNED_BYTE' },
  { lasName: 'Intensity', batchName: 'Intensity', componentType: 'UNSIGNED_SHORT' },
];
const values = [[2, 6], [1000, 40000]];
const buf = buildQuantizedPnts(lonLatH, colors, { specs, values });

// parse pnts header
const dv = new DataView(buf);
const ftJSONlen = dv.getUint32(12, true);
const ftBinLen = dv.getUint32(16, true);
const btJSONlen = dv.getUint32(20, true);
const btBinLen = dv.getUint32(24, true);
assert(btJSONlen > 0 && btBinLen > 0, 'batch table present (JSON+binary lengths > 0)');

const dec = new TextDecoder();
const ftJSON = JSON.parse(dec.decode(new Uint8Array(buf, 28, ftJSONlen)));
assert(ftJSON.BATCH_LENGTH === 2, 'FT BATCH_LENGTH = 2');
assert(ftJSON.BATCH_ID && ftJSON.BATCH_ID.componentType === 'UNSIGNED_SHORT', 'FT BATCH_ID UNSIGNED_SHORT present');

const btJSON = JSON.parse(dec.decode(new Uint8Array(buf, 28 + ftJSONlen + ftBinLen, btJSONlen)));
assert(btJSON.Classification.componentType === 'UNSIGNED_BYTE', 'BT Classification UNSIGNED_BYTE');
assert(btJSON.Intensity.componentType === 'UNSIGNED_SHORT', 'BT Intensity UNSIGNED_SHORT');

// batch table binary: read Classification (offset 0) + Intensity values
const btBinStart = 28 + ftJSONlen + ftBinLen + btJSONlen;
const cls = new Uint8Array(buf, btBinStart + btJSON.Classification.byteOffset, 2);
assert(cls[0] === 2 && cls[1] === 6, 'Classification values [2,6], got ' + cls);
const intRaw = new Uint16Array(buf.slice(btBinStart + btJSON.Intensity.byteOffset, btBinStart + btJSON.Intensity.byteOffset + 4));
assert(intRaw[0] === 1000 && intRaw[1] === 40000, 'Intensity values [1000,40000], got ' + intRaw);

console.log('PASS pnts-batch');
process.exit(0);
