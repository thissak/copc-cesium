// 속성 충실도 검증: resolver + decode + pnts batch table 라운드트립.
// 실행: npx tsx scripts/check-attributes.ts [url]   (기본 autzen)
import { resolveAttributes } from '../src/attributes';

function assert(cond: unknown, msg: string): void {
  if (!cond) { console.error('FAIL: ' + msg); process.exit(1); }
}

// ── resolver ──
const AVAIL = ['X', 'Y', 'Z', 'Intensity', 'Classification', 'ReturnNumber', 'NumberOfReturns', 'GpsTime'];
const def = resolveAttributes(AVAIL, undefined);
assert(def.map((s) => s.batchName).join(',') === 'Classification,Intensity,ReturnNumber,NumberOfReturns',
  'curated default = 4 standard attrs in order, got ' + def.map((s) => s.batchName));
assert(def.find((s) => s.batchName === 'Classification')!.componentType === 'UNSIGNED_BYTE', 'Classification → UNSIGNED_BYTE');
assert(def.find((s) => s.batchName === 'Intensity')!.componentType === 'UNSIGNED_SHORT', 'Intensity → UNSIGNED_SHORT');

const all = resolveAttributes(AVAIL, 'all').map((s) => s.batchName);
assert(!all.includes('X') && all.includes('GpsTime') && all.includes('Classification'), "'all' excludes XYZ, includes GpsTime+Classification, got " + all);

const explicit = resolveAttributes(AVAIL, ['Classification', 'NopeDim']);
assert(explicit.length === 1 && explicit[0].batchName === 'Classification', 'unknown dim skipped, got ' + explicit.map((s) => s.batchName));

console.log('PASS resolver');

// ── decode (real autzen) ──
import { Copc } from 'copc';
import { openCopc, decodeNode } from '../src/copc-core';

const url = process.argv[2] ?? 'https://s3.amazonaws.com/hobu-lidar/autzen-classified.copc.laz';
const s = await openCopc(url);
const rootKey = '0-0-0-0';
const view0 = await Copc.loadPointDataView(s.getter, s.copc, s.nodes[rootKey]!);
const dims = Object.keys(view0.dimensions);
const specs = resolveAttributes(dims, ['Classification', 'Intensity']);
assert(specs.length === 2, 'autzen has Classification + Intensity');

const nd = await decodeNode(s, rootKey, undefined, 'rgb', new Set([7, 18]), specs);
assert(nd && nd.attrValues && nd.attrValues.length === 2, 'attrValues returned for 2 specs');
assert(nd!.attrValues![0].length === nd!.count, 'attrValues[0] length === kept count');

// cross-check: first kept point's Classification matches a fresh raw read at the same kept index
const gc = view0.getter('Classification');
// kept indices: reproduce the hideClass filter to find first kept original index
let firstKept = -1;
for (let i = 0; i < view0.pointCount; i++) { const c = gc(i) | 0; if (c !== 7 && c !== 18) { firstKept = i; break; } }
assert(firstKept >= 0, 'has a kept point');
assert(nd!.attrValues![0][0] === (gc(firstKept) | 0), 'first kept Classification matches raw, got ' + nd!.attrValues![0][0] + ' vs ' + (gc(firstKept) | 0));

console.log('PASS decode-attributes');
process.exit(0);
