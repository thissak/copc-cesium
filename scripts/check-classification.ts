// 클래스별 Z 분포 진단: "떠다니는 점"이 몇 번 classification 인지 측정으로 식별.
// 실행: npx tsx scripts/check-classification.ts [url]   (기본 millsite)
import { Copc } from 'copc';
import { openCopc } from '../src/copc-core';

const url = process.argv[2] ?? 'https://s3.amazonaws.com/hobu-lidar/millsite.copc.laz';
const MAX_NODES = 60;
const MAX_POINTS = 400_000;

const ASPRS: Record<number, string> = {
  0: 'created/never',
  1: 'unclassified',
  2: 'ground',
  3: 'low veg',
  4: 'med veg',
  5: 'high veg',
  6: 'building',
  7: 'LOW NOISE',
  8: 'model key',
  9: 'water',
  17: 'bridge deck',
  18: 'HIGH NOISE',
};

const s = await openCopc(url);
const keys = Object.keys(s.nodes)
  .filter((k) => s.nodes[k])
  .sort((a, b) => Number(a.split('-')[0]) - Number(b.split('-')[0]))
  .slice(0, MAX_NODES);

type Stat = { count: number; minZ: number; maxZ: number; sumZ: number };
const byClass = new Map<number, Stat>();
let total = 0;
let gMin = Infinity;
let gMax = -Infinity;
let hasClass = false;

for (const key of keys) {
  if (total >= MAX_POINTS) break;
  const node = s.nodes[key];
  if (!node) continue;
  const view = await Copc.loadPointDataView(s.getter, s.copc, node);
  const n = view.pointCount;
  const gz = view.getter('Z');
  const hc = 'Classification' in view.dimensions;
  hasClass = hasClass || hc;
  const gc = hc ? view.getter('Classification') : () => -1;
  for (let i = 0; i < n; i++) {
    const z = gz(i) * s.zUnit;
    const c = gc(i) | 0;
    if (z < gMin) gMin = z;
    if (z > gMax) gMax = z;
    let st = byClass.get(c);
    if (!st) {
      st = { count: 0, minZ: Infinity, maxZ: -Infinity, sumZ: 0 };
      byClass.set(c, st);
    }
    st.count++;
    st.sumZ += z;
    if (z < st.minZ) st.minZ = z;
    if (z > st.maxZ) st.maxZ = z;
    total++;
  }
}

const headerZ: [number, number] = [s.copc.header.min[2] * s.zUnit, s.copc.header.max[2] * s.zUnit];
console.log(`URL: ${url}`);
console.log(`헤더 전역 Z: [${headerZ[0].toFixed(1)}, ${headerZ[1].toFixed(1)}]  (span ${(headerZ[1] - headerZ[0]).toFixed(1)}m)`);
console.log(`샘플: 노드 ${keys.length}개 · ${total.toLocaleString()}점 · Classification 존재=${hasClass}`);
console.log(`샘플 Z 범위: [${gMin.toFixed(1)}, ${gMax.toFixed(1)}]`);
console.log('\nclass | name          | count    | %     | minZ   | maxZ   | meanZ');
console.log('------+---------------+----------+-------+--------+--------+-------');
const rows = [...byClass.entries()].sort((a, b) => a[0] - b[0]);
for (const [c, st] of rows) {
  const name = (ASPRS[c] ?? '?').padEnd(13);
  const pct = ((st.count / total) * 100).toFixed(2).padStart(5);
  console.log(
    `${String(c).padStart(5)} | ${name} | ${String(st.count).padStart(8)} | ${pct} | ` +
      `${st.minZ.toFixed(0).padStart(6)} | ${st.maxZ.toFixed(0).padStart(6)} | ${(st.sumZ / st.count).toFixed(0).padStart(6)}`,
  );
}

// 떠다니는 점 후보: 지면(class 2) meanZ 대비 한참 위 + 희소
const ground = byClass.get(2);
if (ground) {
  const gMean = ground.sumZ / ground.count;
  const floaters = rows.filter(([c, st]) => c !== 2 && st.sumZ / st.count > gMean + (headerZ[1] - headerZ[0]) * 0.3);
  console.log(
    `\n지면(class2) meanZ=${gMean.toFixed(0)}m. 지면+30%span 이상 높이 뜨는 클래스: ` +
      (floaters.length ? floaters.map(([c]) => `${c}(${ASPRS[c] ?? '?'})`).join(', ') : '없음'),
  );
}
process.exit(0);
