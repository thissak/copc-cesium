// 이슈 #02 — range coalescing 실현가능성/이득 측정.
// 얕은 노드(레벨 0~3, msse=8 이 로드하는 범위)의 pointDataOffset/Length 를 읽어
// 파일 내 연속성을 분석한다. 연속적이면 인접 청크를 한 range GET 으로 병합 가능(round-trip↓).
// 사용: `tsx scripts/bench/coalesce-feasibility.ts [maxLevel]`
import { openCopc, loadSubPage } from '../../src/copc-core';

const URL = 'https://s3.amazonaws.com/hobu-lidar/millsite.copc.laz';
const maxLevel = Number(process.argv[2] || '3');

function analyze(nodes: Array<{ off: number; len: number }>, gapKB: number) {
  // 오프셋 순 정렬 후, 인접 청크 사이 gap <= 임계면 한 run 으로 병합.
  const sorted = [...nodes].sort((a, b) => a.off - b.off);
  const gap = gapKB * 1024;
  let runs = 0;
  let runStart = -1;
  let runEnd = -1;
  let spanBytes = 0; // 병합 range 가 실제로 fetch 하는 총 바이트(gap 포함)
  let dataBytes = 0; // 실제 노드 데이터 바이트
  for (const n of sorted) {
    dataBytes += n.len;
    if (runStart < 0) {
      runStart = n.off;
      runEnd = n.off + n.len;
      runs = 1;
    } else if (n.off - runEnd <= gap) {
      runEnd = Math.max(runEnd, n.off + n.len); // 같은 run 확장
    } else {
      spanBytes += runEnd - runStart; // 이전 run 마감
      runStart = n.off;
      runEnd = n.off + n.len;
      runs++;
    }
  }
  if (runStart >= 0) spanBytes += runEnd - runStart;
  const wastePct = spanBytes > 0 ? ((spanBytes - dataBytes) / spanBytes) * 100 : 0;
  return { runs, spanMB: spanBytes / 1e6, dataMB: dataBytes / 1e6, wastePct };
}

async function main() {
  console.log(`coalesce 실현가능성 — millsite, 레벨 ≤ ${maxLevel}\n`);
  const s = await openCopc(URL);
  // 얕은 서브페이지 로드(레벨 ≤ maxLevel 의 자식까지 채우기)
  for (const key of Object.keys(s.pages)) {
    if (Number(key.split('-')[0]) <= maxLevel) await loadSubPage(s, key);
  }
  const shallow = Object.entries(s.nodes)
    .filter(([k]) => Number(k.split('-')[0]) <= maxLevel)
    .map(([k, n]: [string, any]) => ({ key: k, lvl: Number(k.split('-')[0]), off: n.pointDataOffset, len: n.pointDataLength }));

  const byLvl: Record<number, number> = {};
  for (const n of shallow) byLvl[n.lvl] = (byLvl[n.lvl] || 0) + 1;
  console.log(`노드 수(레벨별): ${JSON.stringify(byLvl)}  총 ${shallow.length}개`);
  console.log(`청크 크기: min=${(Math.min(...shallow.map((n) => n.len)) / 1024).toFixed(0)}KB max=${(Math.max(...shallow.map((n) => n.len)) / 1024).toFixed(0)}KB`);
  const offs = shallow.map((n) => n.off).sort((a, b) => a - b);
  console.log(`오프셋 범위: ${(offs[0] / 1e6).toFixed(1)}MB ~ ${(offs[offs.length - 1] / 1e6).toFixed(1)}MB (파일 내 분포 폭 ${((offs[offs.length - 1] - offs[0]) / 1e6).toFixed(1)}MB)\n`);

  console.log(`gap임계 | 병합 range 수 | fetch범위MB | 데이터MB | gap낭비% | round-trip 감소`);
  for (const gapKB of [0, 64, 256, 1024, 4096]) {
    const r = analyze(shallow, gapKB);
    console.log(
      `${String(gapKB).padStart(6)}KB | ${String(r.runs).padStart(13)} | ${r.spanMB.toFixed(1).padStart(11)} | ${r.dataMB.toFixed(1).padStart(8)} | ${r.wastePct.toFixed(1).padStart(8)} | ${shallow.length}→${r.runs} (${(shallow.length / r.runs).toFixed(1)}×)`,
    );
  }
  console.log(`\n해석: 병합 range 수가 곧 round-trip 수. 노드 ${shallow.length}개를 적은 range 로 줄일수록 deep-load 단축(각 round-trip ~0.65s TTFB 절감). gap낭비%가 낮아야 실이득.`);
}
main().catch((e) => {
  console.error('fatal', e);
  process.exit(1);
});
