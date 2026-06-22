// scripts/bench/profile-axes.ts — 정규화 COPC의 내부 계산 4축(IO/decode/reproject/build) 분해.
// 사용: npx tsx scripts/bench/profile-axes.ts <copcUrl> [maxDepth=3] [runs=5]
//   copcUrl은 로컬 서버(serve-copc) URL 권장(IO 결정화). S3 URL도 가능.
import { Copc } from 'copc';
import { resolveCrs } from '../../src/copc-core';
import { makeTimedGetter } from './axis-getter';
import { measureNode, type NodeAxes } from './axis-measure';

export function selectNodes(nodes: Record<string, { pointDataLength: number } | undefined>, maxDepth: number): string[] {
  return Object.keys(nodes)
    .filter((k) => nodes[k] && nodes[k]!.pointDataLength > 0 && Number(k.split('-')[0]) <= maxDepth)
    .sort((a, b) => Number(a.split('-')[0]) - Number(b.split('-')[0]) || (a < b ? -1 : a > b ? 1 : 0));
}

export type AxisStat = { ms: number; pct: number; msPerM: number };
export type AxisReport = { points: number; io: AxisStat; decode: AxisStat; reproject: AxisStat; build: AxisStat; totalMs: number };

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(0.5 * s.length))];
}

export function aggregate(runs: NodeAxes[][]): AxisReport {
  const sum = (run: NodeAxes[], k: keyof NodeAxes) => run.reduce((a, x) => a + x[k], 0);
  const io = median(runs.map((r) => sum(r, 'ioMs')));
  const decode = median(runs.map((r) => sum(r, 'decodeMs')));
  const reproject = median(runs.map((r) => sum(r, 'reprojectMs')));
  const build = median(runs.map((r) => sum(r, 'buildMs')));
  const points = median(runs.map((r) => sum(r, 'points')));
  const totalMs = io + decode + reproject + build;
  const stat = (ms: number): AxisStat => ({ ms, pct: totalMs ? (ms / totalMs) * 100 : 0, msPerM: points ? ms / (points / 1e6) : 0 });
  return { points, io: stat(io), decode: stat(decode), reproject: stat(reproject), build: stat(build), totalMs };
}

export function formatReport(label: string, r: AxisReport): string {
  const rows: Array<[string, AxisStat]> = [['IO(local)', r.io], ['decode(laz)', r.decode], ['reproject(proj4)', r.reproject], ['build(pnts)', r.build]];
  const top = rows.reduce((m, x) => (x[1].ms > m[1].ms ? x : m));
  const line = (name: string, s: AxisStat) =>
    `| ${name.padEnd(16)} | ${s.ms.toFixed(1).padStart(8)} | ${s.pct.toFixed(0).padStart(3)}% | ${s.msPerM.toFixed(1).padStart(8)} |`;
  return [
    `### 4축 분해 — ${label} (${(r.points / 1e6).toFixed(2)}M점)`,
    '',
    '| 축 | ms | % | ms/1M점 |',
    '|----|----|---|---------|',
    ...rows.map(([n, s]) => line(n, s)),
    `| **internal** | **${r.totalMs.toFixed(1)}** | 100% | — |`,
    '',
    `**BOTTLENECK: ${top[0]}** (${top[1].pct.toFixed(0)}%, ${top[1].msPerM.toFixed(1)} ms/1M점)`,
  ].join('\n');
}

async function main() {
  const url = process.argv[2];
  if (!url) { console.error('usage: profile-axes.ts <copcUrl> [maxDepth=3] [runs=5]'); process.exit(1); }
  const maxDepth = Number(process.argv[3] || '3');
  const runs = Number(process.argv[4] || '5');

  const { getter, io } = makeTimedGetter(url);
  const copc = await Copc.create(getter);
  const { nodes } = await Copc.loadHierarchyPage(getter, copc.info.rootHierarchyPage);
  const { toWgs, zUnit } = resolveCrs(copc.wkt);
  const zRange: [number, number] = [copc.header.min[2] * zUnit, copc.header.max[2] * zUnit];
  const keys = selectNodes(nodes as any, maxDepth);
  if (!keys.length) { console.error('선택된 노드 0개'); process.exit(1); }

  const allRuns: NodeAxes[][] = [];
  for (let run = 0; run < runs + 1; run++) {
    const out: NodeAxes[] = [];
    for (const k of keys) {
      io.length = 0;
      const ax = await measureNode(getter, io, copc, nodes[k]!, toWgs, zUnit, zRange);
      if (ax) out.push(ax);
    }
    if (run > 0) allRuns.push(out); // run 0 = 워밍업 제외
  }
  const report = aggregate(allRuns);
  console.log(formatReport(`${url} · depth≤${maxDepth} · ${keys.length}노드 · ${runs}회median`, report));
}
// 직접 실행 시에만 main (테스트 import 시 미실행)
if (process.argv[1] && /profile-axes\.ts$/.test(process.argv[1]) && !/check-profile-axes\.ts$/.test(process.argv[1])) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
