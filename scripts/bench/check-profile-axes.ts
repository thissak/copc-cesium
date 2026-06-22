// scripts/bench/check-profile-axes.ts — 집계·median·정규화 순수 로직 검증(네트워크 무관).
import { aggregate, selectNodes } from './profile-axes';
import type { NodeAxes } from './axis-measure';

function assert(c: boolean, m: string) { if (!c) { console.log('FAIL ' + m); process.exit(1); } console.log('ok: ' + m); }

// selectNodes: depth = key 의 첫 토큰
const nodes: any = { '0-0-0-0': { pointDataLength: 10 }, '1-0-0-0': { pointDataLength: 5 }, '2-0-0-0': { pointDataLength: 0 }, '1-1-0-0': { pointDataLength: 7 } };
const sel = selectNodes(nodes, 1);
assert(JSON.stringify(sel) === JSON.stringify(['0-0-0-0', '1-0-0-0', '1-1-0-0']), 'depth≤1·점>0 만, depth 오름차순');

// aggregate: 2 run × 2 노드. run 합 = 노드 합. median(2개)=상위값(Math.floor(0.5*2)=1 → 정렬 2번째)
const r1: NodeAxes[] = [
  { points: 1_000_000, ioMs: 1, decodeMs: 10, reprojectMs: 2, buildMs: 1 },
  { points: 1_000_000, ioMs: 1, decodeMs: 10, reprojectMs: 2, buildMs: 1 },
];
const r2: NodeAxes[] = [
  { points: 1_000_000, ioMs: 1, decodeMs: 20, reprojectMs: 4, buildMs: 2 },
  { points: 1_000_000, ioMs: 1, decodeMs: 20, reprojectMs: 4, buildMs: 2 },
];
const agg = aggregate([r1, r2]);
assert(agg.points === 2_000_000, 'points 합 = 2M (run 무관 동일)');
// run 합: run1 decode=20, run2 decode=40 → median(2개)=40
assert(agg.decode.ms === 40, `decode median run-sum = 40 (got ${agg.decode.ms})`);
assert(Math.abs(agg.decode.msPerM - 40 / 2) < 1e-6, 'decode ms/1M점 = 20');
const pctSum = agg.io.pct + agg.decode.pct + agg.reproject.pct + agg.build.pct;
assert(Math.abs(pctSum - 100) < 0.5, '축 % 합 ≈ 100');
console.log('AGG PASS ✅');
