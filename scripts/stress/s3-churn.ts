// S3 — 생성/정착/파괴 사이클 반복 (churn). 상태 누적 결함을 정면으로 잰다.
//
// 매 라운드: fromUrl → 카메라 조준 → 타일 60개 정착까지 대기 → destroy.
// 라운드가 갈수록 정착이 느려지거나(누적 오염) heap 이 단조 증가하면(누수) 결함.
//
// 실행: npm run dev 후 → tsx scripts/stress/s3-churn.ts <local.copc.laz> [rounds]
import { chromium } from 'playwright';
import { startFaultServer } from './fault-server';

const file = process.argv[2];
const ROUNDS = Number(process.argv[3] ?? 10);
const KEEPALIVE = process.argv.includes('--keepalive');
const PORT = process.env.PORT || '5173';
if (!file) {
  console.error('usage: tsx scripts/stress/s3-churn.ts <path/to/file.copc.laz> [rounds]');
  process.exit(2);
}

const srv = await startFaultServer(file);
const browser = await chromium.launch({
  headless: true,
  args: ['--ignore-gpu-blocklist', '--enable-gpu-rasterization', '--use-angle=d3d11', '--js-flags=--expose-gc'],
});
const page = await (await browser.newContext({ viewport: { width: 1920, height: 1080 } })).newPage();
const pageErrors: string[] = [];
page.on('pageerror', (e) => pageErrors.push(e.message.slice(0, 200)));
page.on('console', (m) => {
  if (m.type() === 'error') pageErrors.push(`console.error: ${m.text().slice(0, 200)}`);
});
await page.goto(`http://localhost:${PORT}/?perf=globe&secs=1`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction('!!window.viewer', undefined, { timeout: 30000 });
await page.waitForTimeout(2500);

const out = (await page.evaluate(`(async () => {
  const URL_ = ${JSON.stringify(srv.url('ok'))};
  const ROUNDS = ${ROUNDS};
  const KEEPALIVE = ${KEEPALIVE ? 1 : 0};
  const TARGET = 55;              // 정착 판정: 준비된 타일 수
  const CAP_MS = 45000;           // 라운드 상한 — 넘으면 STALL
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const { CopcTileset } = await import('/src/copc-tileset.ts');
  const heap = () => (performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : -1);
  // A/B: keepalive 세션을 하나 붙들면 마지막 세션 destroy 시의 worker.terminate 가 일어나지 않는다.
  let keep = null;
  if (KEEPALIVE) { keep = await CopcTileset.fromUrl(URL_, {}); }
  const rows = [];
  for (let r = 0; r < ROUNDS; r++) {
    const t0 = performance.now();
    const ts = await CopcTileset.fromUrl(URL_, {});
    const created = performance.now() - t0;
    viewer.scene.primitives.add(ts);
    viewer.camera.flyToBoundingSphere(ts.copcPointBoundingSphere, { duration: 0 });
    let ready = 0, failed = 0;
    ts.tileFailed.addEventListener(() => { failed++; });
    while (performance.now() - t0 < CAP_MS) {
      await sleep(200);
      ready = ts.statistics.numberOfTilesWithContentReady;
      if (ready >= TARGET) break;
    }
    const settle = performance.now() - t0;
    const stats = ts.copcDecodeStats();
    const nodes = ts.copcNodeCount();
    viewer.scene.primitives.remove(ts);
    await sleep(600);
    rows.push({ r, createMs: Math.round(created), settleMs: Math.round(settle), ready, failed, nodes,
                decodeStarted: stats.started, inflight: stats.inflight, heapMB: heap(),
                stalled: ready < TARGET });
  }
  if (keep) keep.destroy();
  return rows;
})()`)) as Record<string, number | boolean>[];

console.log('round  create   settle  ready fail nodes  decodeStarted inflight  heapMB');
for (const r of out) {
  console.log(
    `${String(r.r).padStart(4)}  ${String(r.createMs).padStart(6)}ms ${String(r.settleMs).padStart(7)}ms` +
      ` ${String(r.ready).padStart(5)} ${String(r.failed).padStart(4)} ${String(r.nodes).padStart(5)}` +
      ` ${String(r.decodeStarted).padStart(13)} ${String(r.inflight).padStart(8)} ${String(r.heapMB).padStart(7)}` +
      (r.stalled ? '   ← STALL' : ''),
  );
}

const settles = out.map((r) => Number(r.settleMs));
const first3 = settles.slice(0, 3).reduce((a, b) => a + b, 0) / 3;
const last3 = settles.slice(-3).reduce((a, b) => a + b, 0) / 3;
const heaps = out.map((r) => Number(r.heapMB));
const stalls = out.filter((r) => r.stalled).length;
const failed = out.reduce((a, r) => a + Number(r.failed), 0);
console.log(`\n정착 처음3 평균 ${first3.toFixed(0)}ms → 마지막3 평균 ${last3.toFixed(0)}ms  (배율 ${(last3 / first3).toFixed(2)}×)`);
console.log(`heap ${heaps[0]}MB → ${heaps[heaps.length - 1]}MB`);
console.log(`STALL ${stalls} 라운드 · tileFailed 합계 ${failed} · pageerror ${pageErrors.length}`);
const maxSettle = Math.max(...settles);
const inflights = out.map((r) => Number(r.inflight));
const inflightGrowth = inflights[inflights.length - 1] - inflights[0];
console.log(`최대 정착 ${maxSettle}ms · inflight 증가 ${inflightGrowth}`);
for (const e of pageErrors.slice(0, 10)) console.log(`  ⚠ ${e}`);

await browser.close();
await srv.close();

// 상대비율만으론 느린 라운드가 앞에 오면 통과한다(교차리뷰 G3) → 절대 기준을 병행:
// SW 백스톱(40s)류 지연은 라운드 하나만 걸려도 결함이고, in-flight 는 GREEN 에서 ±2 안팎이다.
const bad = stalls > 0 || failed > 0 || last3 / first3 > 2 || maxSettle > 10_000 || inflightGrowth > 10;
console.log(bad ? '\nFAIL — churn 에서 열화/실패 발생' : '\nPASS — churn 라운드가 안정');
process.exit(bad ? 1 : 0);
