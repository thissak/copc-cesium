// scripts/bench/run-axis-profile.ts — 로컬 서버 기동 → 4축 측정 → md/json 산출.
// 사용: npx tsx scripts/bench/run-axis-profile.ts [data/norm-autzen-2M.copc.laz] [maxDepth=3] [runs=5]
import { writeFileSync, existsSync } from 'node:fs';
import { Copc } from 'copc';
import { resolveCrs, makeGridReprojector } from '../../src/copc-core';
import { startCopcServer } from './serve-copc';
import { makeTimedGetter } from './axis-getter';
import { measureNode, type NodeAxes } from './axis-measure';
import { selectNodes, aggregate, formatReport, loadNodesToDepth } from './profile-axes';

async function main() {
  const file = process.argv[2] || 'data/norm-autzen-2M.copc.laz';
  const maxDepth = Number(process.argv[3] || '3');
  const runs = Number(process.argv[4] || '5');
  if (!Number.isInteger(runs) || runs < 1) { console.error('runs must be an integer >= 1'); process.exit(1); }
  if (!Number.isInteger(maxDepth) || maxDepth < 0) { console.error('maxDepth must be an integer >= 0'); process.exit(1); }
  if (!existsSync(file)) { console.error(`없음: ${file} — 먼저 bash scripts/bench/gen-norm-copc.sh`); process.exit(1); }

  const srv = await startCopcServer(file);
  try {
    const { getter, io } = makeTimedGetter(srv.url);
    const copc = await Copc.create(getter);
    const nodes = await loadNodesToDepth(getter, copc, maxDepth);
    const { toWgs, zUnit } = resolveCrs(copc.wkt);
    const reproj = makeGridReprojector(toWgs, copc.header.min, copc.header.max);
    const zRange: [number, number] = [copc.header.min[2] * zUnit, copc.header.max[2] * zUnit];
    const keys = selectNodes(nodes as any, maxDepth);
    if (!keys.length) { console.error('선택된 노드 0개'); process.exit(1); }

    const allRuns: NodeAxes[][] = [];
    for (let r = 0; r < runs + 1; r++) {
      const out: NodeAxes[] = [];
      for (const k of keys) { io.length = 0; const ax = await measureNode(getter, io, copc, nodes[k]!, reproj, zUnit, zRange); if (ax) out.push(ax); }
      if (r > 0) {
        if (out.length === 0) { console.error('측정 노드 0개 — 빈 결과 기록 방지'); process.exit(1); }
        allRuns.push(out);
      }
    }
    const rep = aggregate(allRuns);
    const label = `${file} · depth≤${maxDepth} · ${keys.length}노드 · ${runs}회median`;
    const md = formatReport(label, rep);
    console.log(md);
    // 산출물 이름을 입력 파일에서 유도 — 입력별로 분리해 raw 측정이 norm 산출물을 덮어쓰지 않게.
    const stem = file.replace(/^.*[/\\]/, '').replace(/\.copc\.laz$|\.laz$/i, '');
    writeFileSync(`docs/bench/axis-${stem}.md`, md + '\n');
    writeFileSync(`docs/bench/axis-${stem}.json`, JSON.stringify(rep, null, 2) + '\n');
  } finally {
    await srv.close();
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
