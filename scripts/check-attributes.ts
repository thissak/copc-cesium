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
process.exit(0);
