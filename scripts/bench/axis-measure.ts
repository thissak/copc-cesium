// scripts/bench/axis-measure.ts — 한 노드를 디코드하며 IO/decode/reproject/build 축을 분리 측정.
// 프로덕션 프리미티브를 경계 타이머로 복제(src 무수정). eager/lazy 무관하게 decode 구간서 X/Y/Z 강제 materialize.
import { Copc } from 'copc';
import { heightColors } from '../../src/colors';
import { buildQuantizedPnts } from '../../src/pnts-quantized';
import type { IoRec } from './axis-getter';

type Reproj = { forward: (xy: number[]) => number[] };
export type NodeAxes = { points: number; ioMs: number; decodeMs: number; reprojectMs: number; buildMs: number };

export async function measureNode(
  getter: (b: number, e: number) => Promise<Uint8Array>,
  io: IoRec[],
  copc: Awaited<ReturnType<typeof Copc.create>>,
  node: { pointDataOffset: number; pointDataLength: number },
  toWgs: Reproj,
  zUnit: number,
  zRange: [number, number],
): Promise<NodeAxes | null> {
  const ioStart = io.length;
  // --- decode: loadPointDataView + 전체 materialize (eager/lazy 무관 강제 디코드) ---
  const tDec = performance.now();
  const view = await Copc.loadPointDataView(getter, copc, node);
  const n = view.pointCount;
  if (n === 0) return null;
  const gx = view.getter('X'), gy = view.getter('Y'), gz = view.getter('Z');
  const xs = new Float64Array(n), ys = new Float64Array(n), zs = new Float64Array(n);
  for (let i = 0; i < n; i++) { xs[i] = gx(i); ys[i] = gy(i); zs[i] = gz(i); } // 강제 materialize
  const ioMs = io.slice(ioStart).reduce((a, r) => a + r.ms, 0);
  const decodeMs = Math.max(0, performance.now() - tDec - ioMs); // 다중 fetch/retry 시 ioMs 합이 wall 초과 가능 → 음수 방지

  // --- reproject: proj4 forward + zUnit (이미 materialize 된 배열에만) ---
  const tRep = performance.now();
  const lonLatH: number[] = new Array(n * 3);
  const zVals: number[] = new Array(n);
  for (let i = 0; i < n; i++) {
    const z = zs[i] * zUnit;
    const out = toWgs.forward([xs[i], ys[i]]);
    lonLatH[i * 3] = out[0]; lonLatH[i * 3 + 1] = out[1]; lonLatH[i * 3 + 2] = z;
    zVals[i] = z;
  }
  const reprojectMs = performance.now() - tRep;

  // --- build: heightColors + buildQuantizedPnts ---
  const tBld = performance.now();
  const colors = heightColors(zVals, n, zRange);
  buildQuantizedPnts(lonLatH, colors);
  const buildMs = performance.now() - tBld;

  return { points: n, ioMs, decodeMs, reprojectMs, buildMs };
}
