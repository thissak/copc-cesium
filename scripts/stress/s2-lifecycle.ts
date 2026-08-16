// S2 — 생명주기/API 오용 스트레스 (실브라우저).
//
// 노리는 결함: destroy 누수, 워커 재생성 실패, 이중 destroy, destroy 후 API 호출,
//              동시 fromUrl 경합, 미처리 rejection, SW 리스너/스로틀 잔류.
//
// 호스트 페이지는 `?perf=globe&secs=1` — 뷰어만 있고 COPC 세션이 없는 조용한 페이지.
// COPC 는 로컬 결함서버('ok' 모드)에서 받아 오프라인·결정적으로 돈다.
//
// 실행: npm run dev 후 → tsx scripts/stress/s2-lifecycle.ts <local.copc.laz>
import { chromium, type Page } from 'playwright';
import { startFaultServer } from './fault-server';

const file = process.argv[2];
if (!file) {
  console.error('usage: tsx scripts/stress/s2-lifecycle.ts <path/to/file.copc.laz>');
  process.exit(2);
}
const PORT = process.env.PORT || '5173';

interface Case {
  name: string;
  /** page.evaluate 본문(문자열) — tsx/esbuild 헬퍼 주입(`__name`) 회피, repo 관례. */
  body: string;
}

// 브라우저 쪽 공통 헬퍼를 한 번 설치한다.
const PRELUDE = `
window.__stress = window.__stress || {};
window.__stress.errors = [];
window.addEventListener('error', (e) => window.__stress.errors.push('error: ' + e.message));
window.addEventListener('unhandledrejection', (e) => window.__stress.errors.push('unhandledrejection: ' + (e.reason && e.reason.message || e.reason)));
window.__stress.load = async () => {
  if (!window.__stress.mod) window.__stress.mod = await import('/src/copc-tileset.ts');
  return window.__stress.mod.CopcTileset;
};
window.__stress.sleep = (ms) => new Promise((r) => setTimeout(r, ms));
window.__stress.heap = () => (performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : -1);
`;

const CASES: Case[] = [
  {
    name: 'L1 create/destroy ×8 (로드 전 즉시 destroy)',
    body: `
      const CopcTileset = await window.__stress.load();
      const heap0 = window.__stress.heap();
      const errs = [];
      for (let i = 0; i < 8; i++) {
        try {
          const ts = await CopcTileset.fromUrl(URL, {});
          viewer.scene.primitives.add(ts);
          viewer.scene.primitives.remove(ts); // remove → destroy
        } catch (e) { errs.push('iter' + i + ': ' + e.message); }
      }
      await window.__stress.sleep(2000);
      // 9번째가 여전히 살아나는가 = 워커/SW 정리 후 재생성 경로
      let revived = false, revivedTiles = 0;
      try {
        const ts = await CopcTileset.fromUrl(URL, {});
        viewer.scene.primitives.add(ts);
        for (let i = 0; i < 40 && ts.statistics.numberOfTilesWithContentReady === 0; i++) await window.__stress.sleep(250);
        revivedTiles = ts.statistics.numberOfTilesWithContentReady;
        revived = revivedTiles > 0;
        viewer.scene.primitives.remove(ts);
      } catch (e) { errs.push('revive: ' + e.message); }
      return { errs, revived, revivedTiles, heap0, heap1: window.__stress.heap() };
    `,
  },
  {
    name: 'L2 두 세션 동시 → 하나만 destroy',
    body: `
      const CopcTileset = await window.__stress.load();
      const a = await CopcTileset.fromUrl(URL, {});
      const b = await CopcTileset.fromUrl(URL, {});
      viewer.scene.primitives.add(a); viewer.scene.primitives.add(b);
      for (let i = 0; i < 40 && b.statistics.numberOfTilesWithContentReady === 0; i++) await window.__stress.sleep(250);
      viewer.scene.primitives.remove(a); // a 만 파괴 — b 는 계속 살아야 한다
      const before = b.statistics.numberOfTilesWithContentReady;
      // b 를 새 시점으로 옮겨 추가 타일을 강제
      viewer.camera.flyToBoundingSphere(b.copcPointBoundingSphere, { duration: 0 });
      await window.__stress.sleep(6000);
      const after = b.statistics.numberOfTilesWithContentReady;
      let snapOk = false;
      try { snapOk = !!(await b.snapPoint(viewer.scene, { x: 960, y: 540 })); } catch (e) {}
      viewer.scene.primitives.remove(b);
      return { before, after, survived: after > 0, snapOk };
    `,
  },
  {
    name: 'L3 스트리밍 도중 destroy',
    body: `
      const CopcTileset = await window.__stress.load();
      const ts = await CopcTileset.fromUrl(URL, { maximumScreenSpaceError: 1 });
      viewer.scene.primitives.add(ts);
      viewer.camera.flyToBoundingSphere(ts.copcPointBoundingSphere, { duration: 0 });
      await window.__stress.sleep(1200);           // 요청이 한창 날아가는 중
      const inflight = ts.copcDecodeStats ? ts.copcDecodeStats().inflight : -1;
      viewer.scene.primitives.remove(ts);
      await window.__stress.sleep(4000);           // 미착륙 응답들이 도착할 시간
      return { inflightAtDestroy: inflight };
    `,
  },
  {
    name: 'L4 이중 destroy',
    body: `
      const CopcTileset = await window.__stress.load();
      const ts = await CopcTileset.fromUrl(URL, {});
      viewer.scene.primitives.add(ts);
      await window.__stress.sleep(500);
      viewer.scene.primitives.remove(ts);
      let second = 'no-throw';
      try { ts.destroy(); } catch (e) { second = e.message; }
      return { second };
    `,
  },
  {
    name: 'L5 destroy 후 API 호출 (snapPoint / attributeRange / copcNodeCount)',
    body: `
      const CopcTileset = await window.__stress.load();
      const ts = await CopcTileset.fromUrl(URL, {});
      viewer.scene.primitives.add(ts);
      for (let i = 0; i < 40 && ts.statistics.numberOfTilesWithContentReady === 0; i++) await window.__stress.sleep(250);
      viewer.scene.primitives.remove(ts);
      const out = {};
      try { out.snap = String(await ts.snapPoint(viewer.scene, { x: 960, y: 540 })); }
      catch (e) { out.snap = 'THROW: ' + e.message; }
      try { out.attrRange = JSON.stringify(await ts.attributeRange('Intensity')); }
      catch (e) { out.attrRange = 'THROW: ' + e.message; }
      try { out.nodeCount = ts.copcNodeCount(); } catch (e) { out.nodeCount = 'THROW: ' + e.message; }
      return out;
    `,
  },
  {
    name: 'L6 동시 fromUrl ×5 (같은 URL)',
    body: `
      const CopcTileset = await window.__stress.load();
      const rs = await Promise.allSettled([0,1,2,3,4].map(() => CopcTileset.fromUrl(URL, {})));
      const ok = rs.filter((r) => r.status === 'fulfilled');
      const rej = rs.filter((r) => r.status === 'rejected').map((r) => r.reason && r.reason.message);
      for (const r of ok) viewer.scene.primitives.add(r.value);
      await window.__stress.sleep(6000);
      const ready = ok.map((r) => r.value.statistics.numberOfTilesWithContentReady);
      for (const r of ok) viewer.scene.primitives.remove(r.value);
      return { fulfilled: ok.length, rejected: rej, ready };
    `,
  },
  {
    name: 'L7 404 URL — 실패 품질',
    body: `
      const CopcTileset = await window.__stress.load();
      let msg = 'NO-THROW (!!)';
      const t0 = performance.now();
      try { await CopcTileset.fromUrl(URL.replace('/copc', '/nope')); } catch (e) { msg = e.message; }
      return { msg, ms: Math.round(performance.now() - t0) };
    `,
  },
];

async function main() {
  const srv = await startFaultServer(file);
  const url = srv.url('ok');
  const browser = await chromium.launch({
    headless: true,
    args: ['--ignore-gpu-blocklist', '--enable-gpu-rasterization', '--use-angle=d3d11', '--hide-scrollbars'],
  });
  const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  const page: Page = await ctx.newPage();
  const consoleErrors: string[] = [];
  page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message.slice(0, 180)}`));
  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(`console.error: ${m.text().slice(0, 180)}`);
  });
  await page.goto(`http://localhost:${PORT}/?perf=globe&secs=1`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForFunction('!!window.viewer', undefined, { timeout: 30000 });
  await page.evaluate(PRELUDE);
  await page.waitForTimeout(2000);

  const report: { name: string; ok: boolean; result: unknown; errors: string[] }[] = [];
  for (const c of CASES) {
    const before = consoleErrors.length;
    process.stdout.write(`  ${c.name} … `);
    let result: unknown;
    let ok = true;
    try {
      result = await page.evaluate(`(async () => { const URL = ${JSON.stringify(url)}; ${c.body} })()`);
    } catch (e) {
      ok = false;
      result = `HARNESS THROW: ${(e as Error).message.slice(0, 300)}`;
    }
    const pageErrs = await page.evaluate('window.__stress.errors.splice(0)') as string[];
    const newConsole = consoleErrors.slice(before);
    report.push({ name: c.name, ok, result, errors: [...pageErrs, ...newConsole] });
    console.log(ok ? 'done' : 'HARNESS FAIL');
    console.log(`      → ${JSON.stringify(result)}`);
    if (pageErrs.length || newConsole.length) {
      for (const e of [...pageErrs, ...newConsole]) console.log(`      ⚠ ${e}`);
    }
  }

  await browser.close();
  await srv.close();
  console.log('\n── S2 요약 ──');
  console.log(JSON.stringify(report, null, 1));
}

main().catch((e) => {
  console.error('[s2] fatal', e);
  process.exit(1);
});
