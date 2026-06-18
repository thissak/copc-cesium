// 이슈 #02 — Eptium 의 S3 요청 패턴 측정(요청 수·크기·동시성·HTTP 버전).
// copc fetch 는 워커에서 일어날 수 있어 CDP Target.setAutoAttach(flatten)로 워커 타깃까지 Network 부착.
// 사용: `tsx scripts/bench/eptium-net.ts [ds]`
import { chromium } from 'playwright';

const DS: Record<string, string> = {
  autzen: 'https://s3.amazonaws.com/hobu-lidar/autzen-classified.copc.laz',
  millsite: 'https://s3.amazonaws.com/hobu-lidar/millsite.copc.laz',
  sofi: 'https://hobu-lidar.s3.amazonaws.com/sofi.copc.laz',
};
const ds = process.argv[2] || 'millsite';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const browser = await chromium.launch({ headless: false });
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const client = await ctx.newCDPSession(page);

  const reqs = new Map<string, { start: number; url: string }>();
  const done: Array<{ dur: number; bytes: number; start: number }> = [];
  let firstTs = 0;
  const onSent = (e: any) => {
    const url = e.request?.url || '';
    if (/\.copc\.laz/.test(url)) {
      const ts = e.timestamp * 1000;
      if (!firstTs) firstTs = ts;
      reqs.set(e.requestId, { start: ts, url });
    }
  };
  const onFinished = (e: any) => {
    const r = reqs.get(e.requestId);
    if (r) done.push({ dur: e.timestamp * 1000 - r.start, bytes: e.encodedDataLength || 0, start: r.start - firstTs });
  };
  client.on('Network.requestWillBeSent', onSent);
  client.on('Network.loadingFinished', onFinished);

  // 워커/서브타깃에도 Network 부착 (flatten — child 이벤트가 같은 client 로 옴)
  await client.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
  client.on('Target.attachedToTarget', async (e: any) => {
    try {
      const sess = (client as any)._connection?.session?.(e.sessionId);
      // Playwright 는 child session 직접 노출 안 함 — flatten 이벤트가 root 로 오길 기대.
    } catch {
      /* noop */
    }
  });
  await client.send('Network.enable');

  await page.goto(`https://viewer.copc.io/?copc=${DS[ds]}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  // 로드 안정까지 충분히 대기(외부 사이트라 settle 훅 없이 시간 기반)
  await sleep(20000);

  const durs = done.map((d) => d.dur).sort((a, b) => a - b);
  const bytes = done.reduce((a, d) => a + d.bytes, 0);
  // 동시성: 구간 겹침
  const ev: Array<[number, number]> = [];
  for (const d of done) {
    ev.push([d.start, 1]);
    ev.push([d.start + d.dur, -1]);
  }
  ev.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let cur = 0,
    mx = 0;
  for (const [, x] of ev) {
    cur += x;
    if (cur > mx) mx = cur;
  }
  const p = (q: number) => (durs.length ? +durs[Math.min(durs.length - 1, Math.floor((q / 100) * durs.length))].toFixed(0) : 0);

  console.log(`\n=== EPTIUM S3 요청 패턴 (ds=${ds}) ===`);
  console.log(`captured 요청 수 : ${done.length}  (page-level CDP — 워커 fetch 면 0 일 수 있음)`);
  console.log(`총 bytes         : ${(bytes / 1e6).toFixed(1)}MB`);
  console.log(`dur/req          : p50=${p(50)} p95=${p(95)} max=${p(100)}ms`);
  console.log(`달성 동시성      : ${mx}`);
  if (done.length === 0) console.log('→ page-level 에 0건: Eptium 도 워커 fetch(우리처럼). CDP flatten 로 미포착.');

  await ctx.close();
  await browser.close();
}
main().catch((e) => {
  console.error('fatal', e);
  process.exit(1);
});
