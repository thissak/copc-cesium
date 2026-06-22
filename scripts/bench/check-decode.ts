// 이슈 #19 재현/분해 — decode(84%)를 (a) laz 압축해제(WASM) vs (b) getter 추출(JS DataView)로 가른다.
// in-memory getter로 IO를 0으로 만들어 순수 decode 비용만 격리(프로파일러 decode 축과 대조).
// copc.js 구조: loadPointDataView→decompressChunk(청크 전체 eager 압축해제, 전 차원) → getter는 그 버퍼의 DataView 읽기.
// 변형: none = loadPointDataView만(압축해제 완료) · xyz = +X/Y/Z 추출(프로덕션) · all = +전 차원 추출(상한).
// 실행: npx tsx scripts/bench/check-decode.ts [file=data/norm-autzen-2M.copc.laz] [maxDepth=5] [runs=5]
import { readFileSync } from 'node:fs';
import { Copc } from 'copc';
import { loadNodesToDepth, selectNodes } from './profile-axes';

const FILE = process.argv[2] || 'data/norm-autzen-2M.copc.laz';
const MAXDEPTH = Number(process.argv[3] || '5');
const RUNS = Number(process.argv[4] || '5');

function median(xs: number[]): number { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; }

async function main() {
  const buf = readFileSync(FILE);
  // in-memory getter: 디스크/네트워크 IO 제거 → 측정 = 압축해제 + 추출만
  const mem = async (b: number, e: number): Promise<Uint8Array> => buf.subarray(b, e);
  const copc = await Copc.create(mem);
  const nodes = await loadNodesToDepth(mem, copc, MAXDEPTH);
  const keys = selectNodes(nodes as any, MAXDEPTH);
  if (!keys.length) { console.error('노드 0개'); process.exit(1); }
  const prf = copc.header.pointDataRecordFormat, prl = copc.header.pointDataRecordLength;

  type V = 'none' | 'xyz' | 'all';
  async function pass(read: V): Promise<{ pts: number; ms: number }> {
    let pts = 0, sink = 0;
    const t = performance.now();
    for (const k of keys) {
      const view = await Copc.loadPointDataView(mem, copc, nodes[k]!); // 여기서 압축해제 완료(eager)
      const n = view.pointCount; pts += n;
      if (read === 'xyz') {
        const gx = view.getter('X'), gy = view.getter('Y'), gz = view.getter('Z');
        for (let i = 0; i < n; i++) sink += gx(i) + gy(i) + gz(i);
      } else if (read === 'all') {
        const gs = Object.keys(view.dimensions).map((d) => view.getter(d));
        for (let i = 0; i < n; i++) for (let j = 0; j < gs.length; j++) sink += gs[j](i);
      }
      // 'none': loadPointDataView 만 — 압축해제는 이미 끝났으므로 압축해제 단독 비용
    }
    if (sink === Infinity) console.log(''); // dead-code 제거 방지
    return { pts, ms: performance.now() - t };
  }

  const variants: V[] = ['none', 'xyz', 'all'];
  const acc: Record<V, { pts: number; msList: number[] }> = { none: { pts: 0, msList: [] }, xyz: { pts: 0, msList: [] }, all: { pts: 0, msList: [] } };
  for (let r = 0; r <= RUNS; r++) {
    for (const v of variants) { const { pts, ms } = await pass(v); if (r > 0) { acc[v].msList.push(ms); acc[v].pts = pts; } }
  }
  const ms1m = (v: V) => median(acc[v].msList) / (acc[v].pts / 1e6);
  const nDims = Object.keys((await Copc.loadPointDataView(mem, copc, nodes[keys[0]]!)).dimensions).length;

  const decompress = ms1m('none');
  const xyzExtract = ms1m('xyz') - decompress;
  const allExtract = ms1m('all') - decompress;
  const pct = (x: number) => ((x / ms1m('xyz')) * 100).toFixed(0);

  console.log(`=== #19 decode 분해 — ${FILE} (PDRF ${prf}, ${prl} B/점, ${nDims}차원, ${keys.length}노드, ${(acc.xyz.pts / 1e6).toFixed(2)}M점, ${RUNS}회median) ===`);
  console.log(`압축해제(decompressChunk, WASM 전체레코드) : ${decompress.toFixed(1)} ms/1M점  (${pct(decompress)}%)`);
  console.log(`XYZ 추출(getter 3N DataView, JS)          : ${xyzExtract.toFixed(1)} ms/1M점  (${pct(xyzExtract)}%)`);
  console.log(`└ 프로덕션 decode(none+xyz)               : ${ms1m('xyz').toFixed(1)} ms/1M점  (프로파일러 decode 축과 대조)`);
  console.log(`전차원 추출(${nDims}dim getter, 상한)        : ${allExtract.toFixed(1)} ms/1M점`);
  console.log('');
  if (decompress > xyzExtract * 3) console.log('해석: 압축해제(WASM)가 지배적 → 레버=압축해제 자체(차원 skip 불가, getter 미세최적화 무의미).');
  else if (xyzExtract > decompress) console.log('해석: getter 추출(JS)이 지배적 → 레버=추출 경로(bulk/typed-array).');
  else console.log('해석: 압축해제·추출 혼재 → 양쪽 검토.');
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
