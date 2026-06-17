// 워커 decode 가 엮는 데이터 경로(resolveAttributes → decodeNode → buildQuantizedPnts)를 헤드리스로 검증.
import { Copc } from 'copc';
import { openCopc, decodeNode } from '../src/copc-core';
import { resolveAttributes } from '../src/attributes';
import { buildQuantizedPnts } from '../src/pnts-quantized';
function assert(c: unknown, m: string): void { if (!c) { console.error('FAIL: ' + m); process.exit(1); } }
const url = process.argv[2] ?? 'https://s3.amazonaws.com/hobu-lidar/autzen-classified.copc.laz';
const s = await openCopc(url);
const key = '0-0-0-0';
const v0 = await Copc.loadPointDataView(s.getter, s.copc, s.nodes[key]!);
const specs = resolveAttributes(Object.keys(v0.dimensions), undefined); // 큐레이션 기본
assert(specs.length >= 1, 'curated specs resolved for autzen, got ' + specs.map((x) => x.batchName));
const nd = await decodeNode(s, key, undefined, 'rgb', new Set([7, 18]), specs);
assert(nd && nd.attrValues && nd.attrValues.length === specs.length, 'attrValues parallel to specs');
const pnts = buildQuantizedPnts(nd!.lonLatH, nd!.colors!, { specs, values: nd!.attrValues! });
const dv = new DataView(pnts);
assert(dv.getUint32(20, true) > 0 && dv.getUint32(24, true) > 0, 'wired pnts has BATCH_TABLE (JSON+binary > 0)');
// Classification present in batch table JSON
const ftJSONlen = dv.getUint32(12, true); const ftBinLen = dv.getUint32(16, true); const btJSONlen = dv.getUint32(20, true);
const btJSON = JSON.parse(new TextDecoder().decode(new Uint8Array(pnts, 28 + ftJSONlen + ftBinLen, btJSONlen)));
assert('Classification' in btJSON, 'Classification in wired batch table, got ' + Object.keys(btJSON));
console.log('PASS attr-pipeline');
process.exit(0);
