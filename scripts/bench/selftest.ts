import { pctDelta, renderReport } from './report';
import type { BenchResult, BenchMeta } from './types';

function assert(cond: boolean, msg: string) {
  if (!cond) {
    console.error('FAIL: ' + msg);
    process.exit(1);
  }
  console.log('ok: ' + msg);
}

assert(pctDelta(80, 100) === '-20%', 'pctDelta 80/100 = -20%');
assert(pctDelta(120, 100) === '+20%', 'pctDelta 120/100 = +20%');
assert(pctDelta(5, 0) === 'n/a', 'pctDelta zero base = n/a');

const mk = (label: string, over: Partial<BenchResult>): BenchResult => ({
  label: label as 'ours' | 'eptium',
  url: 'u',
  ok: true,
  glRenderer: 'Apple M4 Pro',
  msse: 32,
  pointsSelected: 577000,
  pointsLength: 0,
  tilesReady: 17,
  tilesTotal: 280,
  bsRadius: 881,
  ttdMs: 1000,
  bytesTotal: 18_000_000,
  reqCount: 22,
  peakHeapMB: 120,
  frametimeMs: { p50: 16, p95: 22, p99: 40 },
  hitchesGt50: 1,
  longTaskTotalMs: 80,
  fpsFromP50: 62,
  ...over,
});

const meta: BenchMeta = {
  dataset: 'autzen',
  datasetUrl: 'https://s3.amazonaws.com/hobu-lidar/autzen-classified.copc.laz',
  msse: 32,
  secs: 20,
  throttle: 'none',
  timestamp: '2026-06-18T00:00:00.000Z',
};

const md = renderReport(mk('ours', { ttdMs: 800 }), mk('eptium', { ttdMs: 1000 }), meta);
assert(md.includes('TTD'), 'report has TTD row');
assert(md.includes('ours') && md.includes('eptium'), 'report has both columns');
assert(/msse/i.test(md) && md.includes('autzen'), 'report has conditions (msse + dataset)');
assert(md.includes('577'), 'report shows pointsSelected witness');
assert(md.includes('frametime'), 'report has Tier 1b frametime row');

const mdFail = renderReport(mk('ours', { ok: false, error: 'timeout' }), mk('eptium', {}), meta);
assert(mdFail.includes('측정 한계'), 'report surfaces !ok target as 측정 한계 section');
assert(mdFail.includes('timeout'), 'report includes the error message for the failed target');

console.log('selftest passed');
