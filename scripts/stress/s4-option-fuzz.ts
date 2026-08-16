// S4 — 공개 옵션 경계값 퍼징. 각 옵션의 극단값에서 무엇이 깨지는가.
//
// 판정: 각 케이스는 셋 중 하나로 끝나야 한다.
//   THREW  = 잘못된 입력이라 명확히 거부       (허용)
//   DREW   = 살아남아 타일을 그림               (허용)
//   DEAD   = 예외도 없고 타일도 없음            → **조용한 죽은 화면 = 결함**
//
// 실행: npm run dev 후 → tsx scripts/stress/s4-option-fuzz.ts <local.copc.laz>
import { chromium } from 'playwright';
import { startFaultServer } from './fault-server';

const file = process.argv[2];
const PORT = process.env.PORT || '5173';
if (!file) {
  console.error('usage: tsx scripts/stress/s4-option-fuzz.ts <path/to/file.copc.laz>');
  process.exit(2);
}

/** [이름, 옵션 JSON, 이 케이스는 거부되는 게 정상인가] */
const CASES: [string, string][] = [
  ['기본값(통제군)', '{}'],
  ['pointBudget: 0 (끔)', '{ "pointBudget": 0 }'],
  ['pointBudget: 1', '{ "pointBudget": 1 }'],
  ['pointBudget: -5', '{ "pointBudget": -5 }'],
  ['pointBudget: 1e12', '{ "pointBudget": 1e12 }'],
  ['msse: 0', '{ "maximumScreenSpaceError": 0 }'],
  ['msse: 0.5', '{ "maximumScreenSpaceError": 0.5 }'],
  ['msse: 1e9', '{ "maximumScreenSpaceError": 1e9 }'],
  ['msse: -1', '{ "maximumScreenSpaceError": -1 }'],
  ['hideClassifications: 0..255 (전부 숨김)', '{ "hideClassifications": Array.from({length:256},(_,i)=>i) }'],
  ['hideClassifications: []', '{ "hideClassifications": [] }'],
  ['maxRequestsPerServer: 1', '{ "maxRequestsPerServer": 1 }'],
  ['maxRequestsPerServer: 0 (끔)', '{ "maxRequestsPerServer": 0 }'],
  ['maxRequestsPerServer: 10000', '{ "maxRequestsPerServer": 10000 }'],
  ['coalesceMaxGap: 0 (끔)', '{ "coalesceMaxGap": 0 }'],
  ['coalesce 퇴화(gap 1e12 · maxBytes 1)', '{ "coalesceMaxGap": 1e12, "coalesceMaxBytes": 1 }'],
  ['coalesceCacheBytes: 0', '{ "coalesceCacheBytes": 0 }'],
  ["attributes: 'all'", '{ "attributes": "all" }'],
  ['attributes: [없는 차원]', '{ "attributes": ["NoSuchDimension"] }'],
  ['attributes: []', '{ "attributes": [] }'],
  ["colorBy: 'height'", '{ "colorBy": "height" }'],
  ["colorBy: 없는 모드", '{ "colorBy": "banana" }'],
  ['pointSize: 0', '{ "pointSize": 0 }'],
  ['pointSize: -5', '{ "pointSize": -5 }'],
  ['pointSize: 1e6', '{ "pointSize": 1e6 }'],
  ['crs: 쓰레기 문자열', '{ "crs": "this-is-not-a-crs" }'],
  ['crs: EPSG:4326 강제(오배치 유도)', '{ "crs": "EPSG:4326" }'],
  ['serviceWorkerScope: /nope/', '{ "serviceWorkerScope": "/nope/" }'],
];

const srv = await startFaultServer(file);
const browser = await chromium.launch({
  headless: true,
  args: ['--ignore-gpu-blocklist', '--enable-gpu-rasterization', '--use-angle=d3d11'],
});
const page = await (await browser.newContext({ viewport: { width: 1920, height: 1080 } })).newPage();
const consoleErr: string[] = [];
page.on('pageerror', (e) => consoleErr.push(`pageerror: ${e.message.slice(0, 160)}`));
page.on('console', (m) => {
  if (m.type() === 'error') consoleErr.push(`console.error: ${m.text().slice(0, 160)}`);
});
await page.goto(`http://localhost:${PORT}/?perf=globe&secs=1`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction('!!window.viewer', undefined, { timeout: 30000 });
await page.waitForTimeout(2500);
await page.evaluate("(async () => { window.__M = await import('/src/copc-tileset.ts'); })()");

// 케이스마다 신규 세션을 쓰되, keepalive 세션을 하나 붙들어 두어 churn 결함(worker terminate 시
// in-flight 유실 → 40s SW 백스톱)이 이 축의 측정을 오염시키지 않게 한다.
await page.evaluate(`(async () => {
  window.__keep = await window.__M.CopcTileset.fromUrl(${JSON.stringify(srv.url('ok'))}, {});
})()`);

const rows: { name: string; verdict: string; detail: string }[] = [];
for (const [name, optExpr] of CASES) {
  const before = consoleErr.length;
  const r = (await page.evaluate(`(async () => {
    const URL_ = ${JSON.stringify(srv.url('ok'))};
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    let ts;
    try { ts = await window.__M.CopcTileset.fromUrl(URL_, ${optExpr}); }
    catch (e) { return { threw: e.message }; }
    viewer.scene.primitives.add(ts);
    viewer.camera.flyToBoundingSphere(ts.copcPointBoundingSphere, { duration: 0 });
    let failed = 0;
    ts.tileFailed.addEventListener(() => { failed++; });
    let ready = 0;
    for (let i = 0; i < 40; i++) { await sleep(250); ready = ts.statistics.numberOfTilesWithContentReady; if (ready >= 20) break; }
    const pts = ts.statistics.numberOfPointsSelected !== undefined ? ts.statistics.numberOfPointsSelected : -1;
    const sphereOk = isFinite(ts.copcPointBoundingSphere.radius) && ts.copcPointBoundingSphere.radius > 0;
    viewer.scene.primitives.remove(ts);
    return { ready, failed, pts, sphereOk };
  })()`)) as { threw?: string; ready?: number; failed?: number; pts?: number; sphereOk?: boolean };
  const newErr = consoleErr.slice(before).filter((e) => !/status of 500/.test(e));
  let verdict: string;
  let detail: string;
  if (r.threw) {
    verdict = 'THREW';
    detail = r.threw.slice(0, 130);
  } else if ((r.ready ?? 0) > 0) {
    verdict = 'DREW';
    detail = `ready=${r.ready} fail=${r.failed} pts=${r.pts} sphere=${r.sphereOk}`;
  } else {
    verdict = 'DEAD';
    detail = `ready=0 fail=${r.failed} sphere=${r.sphereOk}` + (newErr.length ? ` | ${newErr[0]}` : ' | 콘솔 에러 없음');
  }
  rows.push({ name, verdict, detail });
  console.log(`  ${verdict.padEnd(6)} ${name.padEnd(40)} ${detail}`);
}

await page.evaluate('window.__keep && window.__keep.destroy()');
await browser.close();
await srv.close();

const dead = rows.filter((r) => r.verdict === 'DEAD');
console.log(`\n── S4 요약 ──  DREW ${rows.filter((r) => r.verdict === 'DREW').length} · THREW ${rows.filter((r) => r.verdict === 'THREW').length} · DEAD ${dead.length}`);
if (dead.length) {
  console.log('조용한 죽은 화면(예외 없이 아무것도 안 그림):');
  for (const d of dead) console.log(`  · ${d.name} — ${d.detail}`);
  process.exit(1);
}
