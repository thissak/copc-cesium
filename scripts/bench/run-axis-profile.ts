// scripts/bench/run-axis-profile.ts — 로컬 서버 기동 → 4축 측정 → md/json 산출.
// 사용: npx tsx scripts/bench/run-axis-profile.ts [data/norm-autzen-2M.copc.laz] [maxDepth=3] [runs=5]
import { writeFileSync, existsSync } from 'node:fs';
import { Copc } from 'copc';
import { resolveCrs } from '../../src/copc-core';
import { startCopcServer } from './serve-copc';
import { makeTimedGetter } from './axis-getter';
import { measureNode, type NodeAxes } from './axis-measure';
import { selectNodes, aggregate, formatReport } from './profile-axes';

async function main() {
  const file = process.argv[2] || 'data/norm-autzen-2M.copc.laz';
  const maxDepth = Number(process.argv[3] || '3');
  const runs = Number(process.argv[4] || '5');
  if (!existsSync(file)) { console.error(`없음: ${file} — 먼저 bash scripts/bench/gen-norm-copc.sh`); process.exit(1); }

  const srv = await startCopcServer(file);
  try {
    const { getter, io } = makeTimedGetter(srv.url);
    const copc = await Copc.create(getter);
    const { nodes } = await Copc.loadHierarchyPage(getter, copc.info.rootHierarchyPage);
    const { toWgs, zUnit } = resolveCrs(copc.wkt);
    const zRange: [number, number] = [copc.header.min[2] * zUnit, copc.header.max[2] * zUnit];
    const keys = selectNodes(nodes as any, maxDepth);

    const allRuns: NodeAxes[][] = [];
    for (let r = 0; r < runs + 1; r++) {
      const out: NodeAxes[] = [];
      for (const k of keys) { io.length = 0; const ax = await measureNode(getter, io, copc, nodes[k]!, toWgs, zUnit, zRange); if (ax) out.push(ax); }
      if (r > 0) allRuns.push(out);
    }
    const rep = aggregate(allRuns);
    const label = `${file} · depth≤${maxDepth} · ${keys.length}노드 · ${runs}회median`;
    const md = formatReport(label, rep);
    console.log(md);
    writeFileSync('docs/bench/axis-autzen-2M.md', md + '\n');
    writeFileSync('docs/bench/axis-autzen-2M.json', JSON.stringify(rep, null, 2) + '\n');
  } finally {
    await srv.close();
  }
}
main();
