// 이슈 #17 사후검증 — bilinear 격자 reproject를 *실제 COPC 점 분포*로 확인.
// check-reproject.ts는 bounds 내 합성 균일격자 점을 썼다. 여기선 실제 노드를 디코드해
// 실 X/Y 점을 꺼내 grid bilinear(src makeGridReprojector) vs proj4 per-point(ground truth) 오차·속도를 측정.
// 실행: npx tsx scripts/bench/check-reproject-realpts.ts <copcFile> [maxDepth=6] [ptCap=6000000]
// raw 원본 취득(gitignore, 1회): curl -sL -o data/raw-autzen.copc.laz https://s3.amazonaws.com/hobu-lidar/autzen-classified.copc.laz
import { open } from 'node:fs/promises';
import { Copc } from 'copc';
import { resolveCrs, makeGridReprojector } from '../../src/copc-core';
import { loadNodesToDepth, selectNodes } from './profile-axes';

const FILE = process.argv[2] || 'data/raw-autzen.copc.laz';
const MAXDEPTH = Number(process.argv[3] || '6');
const PTCAP = Number(process.argv[4] || '6000000');

async function fsGetter(path: string) {
  const fh = await open(path, 'r');
  return async (begin: number, end: number): Promise<Uint8Array> => {
    const buf = Buffer.alloc(end - begin);
    await fh.read(buf, 0, end - begin, begin);
    return new Uint8Array(buf);
  };
}

async function main() {
  const getter = await fsGetter(FILE);
  const copc = await Copc.create(getter);
  const { toWgs, zUnit } = resolveCrs(copc.wkt);
  const [minx, miny] = copc.header.min;
  const [maxx, maxy] = copc.header.max;
  void zUnit;

  // --- 실제 노드 디코드 → 실 X/Y 수집 (ptCap 까지) ---
  const nodes = await loadNodesToDepth(getter, copc, MAXDEPTH);
  const keys = selectNodes(nodes as any, MAXDEPTH);
  const xs: number[] = [], ys: number[] = [];
  for (const k of keys) {
    if (xs.length >= PTCAP) break;
    const view = await Copc.loadPointDataView(getter, copc, nodes[k]!);
    const n = view.pointCount;
    if (n === 0) continue;
    const gx = view.getter('X'), gy = view.getter('Y');
    for (let i = 0; i < n && xs.length < PTCAP; i++) { xs.push(gx(i)); ys.push(gy(i)); }
  }
  const N = xs.length;
  if (N === 0) { console.error('실 점 0개 — 디코드 실패'); process.exit(1); }

  // --- ground truth: proj4 per-point ---
  const truth = new Float64Array(N * 2);
  let t = performance.now();
  for (let i = 0; i < N; i++) {
    const o = toWgs.forward([xs[i], ys[i]]) as number[];
    truth[i * 2] = o[0]; truth[i * 2 + 1] = o[1];
  }
  const proj4Ms = performance.now() - t;

  // --- src makeGridReprojector (가드/폴백 내장), 격자/폴백 경로 판별을 위해 toWgs 호출 카운트 ---
  let projCalls = 0;
  const counting = { forward: (c: number[]) => { projCalls++; return toWgs.forward(c) as number[]; } } as typeof toWgs;
  const buildStart = performance.now();
  const gr = makeGridReprojector(counting, copc.header.min, copc.header.max);
  const buildMs = performance.now() - buildStart;
  const buildCalls = projCalls; // 격자 빌드 + 가드 샘플에 쓴 proj4 호출

  const grid = new Float64Array(N * 2);
  t = performance.now();
  for (let i = 0; i < N; i++) {
    const o = gr.forward(xs[i], ys[i]);
    grid[i * 2] = o[0]; grid[i * 2 + 1] = o[1];
  }
  const gridMs = performance.now() - t;
  const fwdCalls = projCalls - buildCalls; // forward 중 proj4 호출: 격자=0, 폴백=N
  const gridPath = fwdCalls === 0;

  // --- 오차: 실 점별 max/평균 (degree → mm) ---
  let maxErrDeg = 0, sumErrDeg = 0;
  for (let i = 0; i < N; i++) {
    const dlon = Math.abs(grid[i * 2] - truth[i * 2]);
    const dlat = Math.abs(grid[i * 2 + 1] - truth[i * 2 + 1]);
    const e = Math.max(dlon, dlat);
    if (e > maxErrDeg) maxErrDeg = e;
    sumErrDeg += e;
  }
  const toMm = (deg: number) => deg * 111320 * 1000;
  const maxMm = toMm(maxErrDeg), meanMm = toMm(sumErrDeg / N);
  const ms1m = (ms: number) => +(ms / (N / 1e6)).toFixed(1);

  console.log(`=== #17 bilinear 실점 검증 — ${FILE} ===`);
  console.log(`CRS: ${String(copc.wkt).slice(0, 50)}…`);
  console.log(`실 점: ${N.toLocaleString()}개 (depth≤${MAXDEPTH}, ${keys.length}노드, cap ${PTCAP.toLocaleString()})`);
  console.log(`extent: ${(maxx - minx).toFixed(0)} × ${(maxy - miny).toFixed(0)} projected units`);
  console.log(`경로: ${gridPath ? `격자 채택 (빌드 ${buildCalls} proj4, forward 0)` : `proj4 폴백 (forward ${fwdCalls} proj4)`}  빌드 ${buildMs.toFixed(1)}ms`);
  console.log(`proj4 per-point : ${proj4Ms.toFixed(0)}ms = ${ms1m(proj4Ms)} ms/1M점`);
  console.log(`grid bilinear   : ${gridMs.toFixed(0)}ms = ${ms1m(gridMs)} ms/1M점  (${(proj4Ms / gridMs).toFixed(1)}× 빠름)`);
  console.log(`오차 vs proj4   : max ${maxMm.toFixed(3)}mm · mean ${meanMm.toFixed(4)}mm`);
  const pass = maxMm < 1; // <1mm 가드 주장 (실점 기준)
  console.log(pass ? 'REAL-POINTS PASS ✅ (실 점 분포서도 <1mm)' : 'FAIL ❌ (>1mm — 가드 미작동?)');
  process.exit(pass ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
