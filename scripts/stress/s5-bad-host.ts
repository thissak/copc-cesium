// S5 — "Range 를 제대로 안 지키는 호스트"에 배포했을 때 브라우저에서 무엇이 보이는가.
//
// S1 이 Node 에서 찾은 조용한 오염이 실제 렌더까지 도달하는지 확인한다.
// 정답(ok 모드) 중심좌표와 대조해, 예외 없이 **엉뚱한 곳에 점이 그려지면** 결함 확정.
//
// 실행: npm run dev 후 → tsx scripts/stress/s5-bad-host.ts <local.copc.laz>
import { chromium } from 'playwright';
import { Copc } from 'copc';
import { httpGetterWithRetry } from '../../src/copc-core';
import { startFaultServer, type FaultMode } from './fault-server';

const file = process.argv[2];
const PORT = process.env.PORT || '5173';
if (!file) {
  console.error('usage: tsx scripts/stress/s5-bad-host.ts <path/to/file.copc.laz>');
  process.exit(2);
}

const srv = await startFaultServer(file);
const clean = await Copc.create(httpGetterWithRetry(srv.url('ok')));
// 헤더·하이어라키는 정상, 점데이터만 계약 위반 — "Range 를 부분적으로만 지키는 호스트".
const scope = { from: 65_537, to: clean.info.rootHierarchyPage.pageOffset - 65_536 };

const browser = await chromium.launch({
  headless: true,
  args: ['--ignore-gpu-blocklist', '--enable-gpu-rasterization', '--use-angle=d3d11'],
});
const page = await (await browser.newContext({ viewport: { width: 1280, height: 720 } })).newPage();
const errs: string[] = [];
page.on('pageerror', (e) => errs.push(`pageerror: ${e.message.slice(0, 150)}`));
page.on('console', (m) => {
  if (m.type() === 'error') errs.push(`console.error: ${m.text().slice(0, 150)}`);
});
await page.goto(`http://localhost:${PORT}/?perf=globe&secs=1`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction('!!window.viewer', undefined, { timeout: 30000 });
await page.waitForTimeout(2500);
await page.evaluate("(async () => { window.__M = await import('/src/copc-tileset.ts'); })()");
// keepalive 세션 — churn 결함(마지막 세션 destroy → worker terminate → 40s SW 백스톱)이
// 이 축의 측정을 오염시키지 않게 워커를 살려 둔다.
await page.evaluate(`(async () => { window.__keep = await window.__M.CopcTileset.fromUrl(${JSON.stringify(srv.url('ok'))}, {}); })()`);

const MODES: FaultMode[] = ['ok', 'norange', 'zero', 'short'];
const rows: Record<string, unknown>[] = [];
for (const mode of MODES) {
  const before = errs.length;
  const url = srv.url(mode, scope);
  const r = (await page.evaluate(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    let ts;
    try { ts = await window.__M.CopcTileset.fromUrl(${JSON.stringify(url)}, {}); }
    catch (e) { return { threw: e.message }; }
    viewer.scene.primitives.add(ts);
    viewer.camera.flyToBoundingSphere(ts.copcPointBoundingSphere, { duration: 0 });
    let failed = 0;
    ts.tileFailed.addEventListener(() => { failed++; });
    let ready = 0;
    for (let i = 0; i < 100; i++) { await sleep(250); ready = ts.statistics.numberOfTilesWithContentReady; if (ready >= 8) break; }
    // 타일 boundingSphere 는 tileset.json(옥트리 큐브)에서 오므로 손상돼도 그대로다 — 렌더 결과를
    // 보려면 **화면 픽셀**을 봐야 한다. 지구본/하늘을 끄고 점만 남긴 뒤 캡처는 하네스가 한다.
    viewer.scene.globe.show = false;
    viewer.scene.skyBox.show = false; viewer.scene.skyAtmosphere.show = false;
    viewer.scene.backgroundColor = window.__M_BLACK || viewer.scene.backgroundColor;
    viewer.scene.requestRender();
    await sleep(1500);
    window.__live = ts;
    return { ready, failed, pointsSelected: ts.statistics.numberOfPointsSelected };
  })()`)) as { threw?: string; ready?: number; failed?: number; tiles?: number; c?: { x: number; y: number; z: number } };
  const shot = await page.locator('canvas').first().screenshot();
  await page.evaluate('window.__live && viewer.scene.primitives.remove(window.__live)');
  rows.push({ mode, ...r, newErrors: errs.length - before, shot });
  console.log(`  ${mode.padEnd(9)} ${JSON.stringify(r)}`);
}

await page.evaluate('window.__keep && window.__keep.destroy()');
await browser.close();
await srv.close();

// 렌더된 픽셀을 정답(ok)과 대조 — 손상 바이트가 예외 없이 화면까지 갔는가.
function meanAbsDiff(a: Buffer, b: Buffer): number {
  const n = Math.min(a.length, b.length);
  let s = 0;
  for (let i = 0; i < n; i++) s += Math.abs(a[i] - b[i]);
  return s / n;
}
const okShot = (rows.find((r) => r.mode === 'ok') as { shot: Buffer }).shot;
console.log('\n── 렌더 픽셀 대조 (정답 대비) ──');
for (const r of rows) {
  const d = meanAbsDiff(okShot, r.shot as Buffer);
  const loud = Number(r.failed) > 0 || r.threw;
  const verdict =
    r.mode === 'ok' ? '(기준)'
    : loud ? `명확히 실패 (tileFailed ${r.failed}${r.threw ? ' / throw' : ''})`
    : d < 0.5 ? '화면 동일'
    : `**화면이 다름(평균 차 ${d.toFixed(1)}/255) — 예외 0 · tileFailed 0 = 조용한 오염**`;
  console.log(`  ${String(r.mode).padEnd(9)} pixelΔ=${d.toFixed(2)}  pts=${r.pointsSelected}  ${verdict}`);
}
