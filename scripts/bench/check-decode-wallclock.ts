// 이슈 #19 Step 4 게이트 — decode가 deep-load *wall-clock*에서 차지하는 비중 + 워커풀 Amdahl 천장을 레짐별로 측정.
// "decode 84%"는 internal-compute 비중일 뿐 wall-clock 비중이 아니다(IO 통제 결과). 워커풀(유일 레버)이 실제로
// wall-clock을 줄이는지는 decode가 wall-clock을 지배할 때뿐 → 레짐별로 측정해 착수 여부를 가린다.
// 모델: 워커풀은 decode만 N분할(IO·build 불변) → Amdahl speedup(N)=1/((1-f)+f/N), f=decode wall-clock 비중.
// 실행: npx tsx scripts/bench/check-decode-wallclock.ts [file=data/norm-autzen-2M.copc.laz] [maxDepth=5] [runs=3]
import { Copc, type Hierarchy } from 'copc';
import { resolveCrs, makeGridReprojector } from '../../src/copc-core';
import { startCopcServer } from './serve-copc';
import { makeTimedGetter } from './axis-getter';
import { measureNode, type NodeAxes } from './axis-measure';
import { selectNodes, loadNodesToDepth } from './profile-axes';

const FILE = process.argv[2] || 'data/norm-autzen-2M.copc.laz';
const MAXDEPTH = Number(process.argv[3] || '5');
const RUNS = Number(process.argv[4] || '3');
// S3 레짐 참조: 이슈 #02 실측 — coalescing 후 deep-load settle ~4800ms, 그 ~99%가 TTFB(디코드 ~1%).
const S3_WALL_MS = 4800, S3_DECODE_FRAC = 0.01;

function median(xs: number[]): number { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; }
const amdahl = (f: number, n: number) => 1 / ((1 - f) + f / n);

async function main() {
  const srv = await startCopcServer(FILE);
  try {
    const { getter, io } = makeTimedGetter(srv.url);
    const copc = await Copc.create(getter);
    const nodes: Hierarchy.Node.Map = await loadNodesToDepth(getter, copc, MAXDEPTH);
    const { toWgs, zUnit } = resolveCrs(copc.wkt);
    const reproj = makeGridReprojector(toWgs, copc.header.min, copc.header.max);
    const zRange: [number, number] = [copc.header.min[2] * zUnit, copc.header.max[2] * zUnit];
    const keys = selectNodes(nodes as any, MAXDEPTH);

    const sums: { io: number; dec: number; rep: number; bld: number; pts: number }[] = [];
    for (let r = 0; r <= RUNS; r++) {
      const acc = { io: 0, dec: 0, rep: 0, bld: 0, pts: 0 };
      for (const k of keys) {
        io.length = 0;
        const ax: NodeAxes | null = await measureNode(getter, io, copc, nodes[k]!, reproj, zUnit, zRange);
        if (ax) { acc.io += ax.ioMs; acc.dec += ax.decodeMs; acc.rep += ax.reprojectMs; acc.bld += ax.buildMs; acc.pts += ax.points; }
      }
      if (r > 0) sums.push(acc);
    }
    const io_ms = median(sums.map((s) => s.io));
    const dec_ms = median(sums.map((s) => s.dec));
    const rep_ms = median(sums.map((s) => s.rep));
    const bld_ms = median(sums.map((s) => s.bld));
    const pts = median(sums.map((s) => s.pts));
    const wall = io_ms + dec_ms + rep_ms + bld_ms; // 직렬 처리 wall-clock proxy
    const f_local = dec_ms / wall;

    console.log(`=== #19 decode wall-clock 비중 + 워커풀 천장 — ${FILE} (${keys.length}노드, ${(pts / 1e6).toFixed(2)}M점, ${RUNS}회median) ===`);
    console.log(`\n[LOCAL 레짐 — IO 로컬서빙(측정)]  deep-load 직렬 wall-clock = ${wall.toFixed(0)}ms`);
    console.log(`  IO ${io_ms.toFixed(0)}ms (${(100 * io_ms / wall).toFixed(0)}%) · decode ${dec_ms.toFixed(0)}ms (${(100 * f_local).toFixed(0)}%) · reproject ${rep_ms.toFixed(0)}ms · build ${bld_ms.toFixed(0)}ms`);
    console.log(`  워커풀(decode N분할) Amdahl speedup: N=2 ${amdahl(f_local, 2).toFixed(2)}× · N=4 ${amdahl(f_local, 4).toFixed(2)}× · N=8 ${amdahl(f_local, 8).toFixed(2)}× · 천장(N→∞) ${amdahl(f_local, 1e9).toFixed(2)}×`);
    console.log(`  → N=4 절감 ${(wall - wall / amdahl(f_local, 4)).toFixed(0)}ms (decode ${dec_ms.toFixed(0)}→${(dec_ms / 4).toFixed(0)}ms)`);

    console.log(`\n[S3 레짐 — 실 네트워크(이슈 #02 실측 참조)]  deep-load settle ≈ ${S3_WALL_MS}ms, 그 중 decode ≈ ${(100 * S3_DECODE_FRAC).toFixed(0)}% (나머지 TTFB)`);
    console.log(`  워커풀 Amdahl speedup: N=4 ${amdahl(S3_DECODE_FRAC, 4).toFixed(3)}× · 천장 ${amdahl(S3_DECODE_FRAC, 1e9).toFixed(3)}×  → 사실상 무이득`);

    console.log(`\n=== 판정 ===`);
    console.log(`decode가 wall-clock을 지배하는 건 LOCAL(빠른 IO) 레짐뿐(${(100 * f_local).toFixed(0)}%). 이때만 워커풀이 deep-load를 ${amdahl(f_local, 4).toFixed(1)}×(N=4)까지 단축.`);
    console.log(`실 S3(IO-bound)에선 decode ~1% → 워커풀 무이득(#02 revert 논리 유효).`);
    console.log(`∴ 워커풀 착수 가치 = 대회/배포 타깃이 fast-IO(로컬·CDN·캐시)인지에 전적으로 좌우됨.`);
    process.exit(0);
  } finally {
    await srv.close();
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
