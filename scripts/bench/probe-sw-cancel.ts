// Phase 0 게이트 (이슈 #20): Chromium 에서 클라이언트가 XHR/fetch 를 abort 하면
// 그 요청을 가로채는 Service Worker 의 `event.request.signal` 이 발화하는가?
//
// 이게 우리 취소 전파 설계의 load-bearing 전제다(아키텍처상 취소 신호의 유일한 진입점이 SW signal).
// Cesium 은 타일 content 를 XMLHttpRequest 로 받고 취소 시 xhr.abort() 한다(소스 확인) → XHR 케이스가 핵심.
// 자가완결: Node http 로 작은 페이지+probe SW 서빙, Playwright(chromium)로 구동. 프로덕션 코드 무수정.
//
// 실행: npx tsx scripts/bench/probe-sw-cancel.ts
import { createServer } from 'http';
import { chromium } from 'playwright';

const SW = `
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
const results = {};
self.addEventListener('message', (e) => {
  if (e.data && e.data.type === 'get') e.ports[0].postMessage(results[e.data.id] || null);
});
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (url.pathname === '/probe') {
    const id = url.searchParams.get('id');
    const rec = { hasSignal: !!e.request.signal, abortedAtStart: e.request.signal ? e.request.signal.aborted : null, aborted: false, completed: false };
    results[id] = rec;
    if (e.request.signal) e.request.signal.addEventListener('abort', () => { rec.aborted = true; });
    // 3s 뒤 응답 — 그 전에 클라이언트가 abort 하므로 signal 발화 여부를 관측할 시간 확보.
    e.respondWith(new Promise((resolve) => setTimeout(() => { rec.completed = true; resolve(new Response('ok')); }, 3000)));
  }
});
`;

const PAGE = `<!doctype html><meta charset=utf8><title>sw-cancel-probe</title><script>
window.__ready = navigator.serviceWorker.register('/sw.js').then(() => navigator.serviceWorker.ready);
window.runXhr = (id) => new Promise((res) => {
  const xhr = new XMLHttpRequest();
  xhr.open('GET', '/probe?id=' + id);
  xhr.onerror = () => res('error'); xhr.onabort = () => res('abort'); xhr.onload = () => res('load');
  xhr.send();
  setTimeout(() => xhr.abort(), 200);
});
window.runFetch = (id) => {
  const ac = new AbortController();
  const p = fetch('/probe?id=' + id, { signal: ac.signal }).then(() => 'load', () => 'rejected');
  setTimeout(() => ac.abort(), 200);
  return p;
};
window.getResult = (id) => new Promise((res) => {
  const ch = new MessageChannel();
  ch.port1.onmessage = (e) => res(e.data);
  navigator.serviceWorker.controller.postMessage({ type: 'get', id }, [ch.port2]);
});
</script>`;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const server = createServer((req, res) => {
    if (req.url === '/sw.js') { res.writeHead(200, { 'Content-Type': 'text/javascript', 'Service-Worker-Allowed': '/' }); res.end(SW); return; }
    if (req.url === '/' || req.url?.startsWith('/index')) { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(PAGE); return; }
    res.writeHead(404); res.end('nf'); // /probe 는 SW 가 가로챔(미제어 시 404)
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  const base = `http://localhost:${port}/`;

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.goto(base, { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => (window as any).__ready);
  // 첫 내비게이션이 미제어면 reload 로 제어 확보
  let controlled = await page.evaluate(() => !!navigator.serviceWorker.controller);
  if (!controlled) { await page.reload({ waitUntil: 'domcontentloaded' }); await page.evaluate(() => (window as any).__ready); }
  controlled = await page.evaluate(() => !!navigator.serviceWorker.controller);
  if (!controlled) throw new Error('SW 가 페이지를 제어하지 못함 (probe 무효)');

  async function trial(kind: 'xhr' | 'fetch', id: string) {
    const fn = kind === 'xhr' ? 'runXhr' : 'runFetch';
    const outcome = await page.evaluate(
      (a: { fn: string; id: string }) => (window as any)[a.fn](a.id),
      { fn, id },
    );
    // abort(200ms) 후 signal 발화를 여러 시점서 폴링 (늦은 발화 아티팩트 배제). 응답은 3s 뒤라 completed=false 여야 함.
    let rec: any;
    for (const step of [800, 700, 1000]) { // 누적 ~800/1500/2500ms
      await sleep(step);
      rec = await page.evaluate((i: string) => (window as any).getResult(i), id);
      if (rec?.aborted) break;
    }
    return { kind, outcome, rec };
  }

  const xhr = await trial('xhr', 'xhr1');
  const fet = await trial('fetch', 'fet1');

  console.log('\n=== Phase 0 게이트: SW event.request.signal 발화 여부 (Chromium) ===');
  for (const t of [xhr, fet]) {
    console.log(
      `[${t.kind}] client outcome=${t.outcome}  SW: hasSignal=${t.rec?.hasSignal} abortedAtStart=${t.rec?.abortedAtStart} ` +
        `signalFired=${t.rec?.aborted} completed=${t.rec?.completed}`,
    );
  }

  const xhrFired = !!xhr.rec?.aborted;
  const fetchFired = !!fet.rec?.aborted;
  console.log('\n--- 판정 ---');
  console.log(`XHR abort → SW signal 발화: ${xhrFired ? 'YES ✅ (SW-signal 설계 가능)' : 'NO ❌ (Cesium 경로=XHR → SW 진입점 없음)'}`);
  console.log(`fetch abort → SW signal 발화: ${fetchFired ? 'YES' : 'NO'}`);
  console.log(
    xhrFired
      ? '\nGATE PASS — Cesium XHR abort 가 SW 에서 관측 가능 → Phase A(SW-signal 기반 취소 전파) 진행 가능'
      : '\nGATE FAIL — XHR abort 가 SW 에 안 들어옴 → SW-signal 기반 설계 불가, 재평가 필요(대안 채널/won\'t-fix)',
  );

  await browser.close();
  await new Promise<void>((r) => server.close(() => r()));
  process.exit(xhrFired ? 0 : 1);
}
main().catch((e) => { console.error('fatal', e); process.exit(2); });
