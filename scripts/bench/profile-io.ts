// 이슈 #02 재현/프로파일 — deep-load 4× 격차의 근본원인(네트워크 vs 디코드 vs 동시성) 분해.
// 우리 워커의 per-decode 타이밍(decodeMs=S3 fetch+laz, buildMs=pnts) + S3 range fetch resource timing
// (개수·지속·동시성)을 settle 후 수집해, 16s 가 어디서 오는지 측정한다.
// 사용: dev 서버 먼저 띄우고 `tsx scripts/bench/profile-io.ts [ds] [msse]`
import { chromium } from 'playwright';
import { resolve } from 'path';
import { fileURLToPath } from 'url';

const PROBE_BUNDLE = resolve(fileURLToPath(import.meta.url), '../probe-bundle.js');
const ds = process.argv[2] || 'millsite';
const msse = Number(process.argv[3] || '8');
const maxReq = Number(process.argv[4] || '0'); // 콘텐츠 host 동시성(0=기본 6). 동시성 레버 스윕용.
const coalesce = process.argv[5]; // '0' 이면 coalescing off (A/B)
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function pct(arr: number[], p: number): number {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  return +s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))].toFixed(1);
}
function sum(arr: number[]): number {
  return arr.reduce((a, b) => a + b, 0);
}
// 구간 [start, start+dur] 들의 최대 동시 겹침 = 달성된 동시성.
function maxConcurrency(iv: Array<{ start: number; dur: number }>): number {
  const ev: Array<[number, number]> = [];
  for (const i of iv) {
    ev.push([i.start, 1]);
    ev.push([i.start + i.dur, -1]);
  }
  ev.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let cur = 0,
    mx = 0;
  for (const [, d] of ev) {
    cur += d;
    if (cur > mx) mx = cur;
  }
  return mx;
}

async function settle(page: any, idx: number, timeoutMs: number): Promise<number> {
  let prev = -1,
    stable = 0;
  const s0 = Date.now();
  while (Date.now() - s0 < timeoutMs) {
    const s: any = await page.evaluate((i: number) => (window as any).BenchProbe.readStats(i), idx);
    const settled = s.pending === 0 && (s.tilesReady > 0 || s.pointsLength > 0);
    const key = s.tilesReady > 0 ? s.tilesReady : s.pointsLength;
    if (settled && key === prev) {
      stable += 250;
      if (stable >= 3000) return Date.now() - s0 - stable;
    } else {
      stable = 0;
      prev = key;
    }
    await sleep(250);
  }
  return Date.now() - s0;
}

async function main() {
  const browser = await chromium.launch({ headless: false });
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  let retries = 0;
  page.on('console', (m) => {
    const t = m.text();
    if (/range 재시도/.test(t)) retries++;
  });
  await page.addInitScript({ path: PROBE_BUNDLE });
  const url = `http://localhost:5173/?ds=${ds}${maxReq > 0 ? `&maxReq=${maxReq}` : ''}${coalesce === '0' ? '&coalesce=0' : ''}`;
  await page.goto(url, { waitUntil: 'domcontentloaded' });

  let idx = -1;
  const t0 = Date.now();
  while (Date.now() - t0 < 45000) {
    idx = await page.evaluate(() => (window as any).BenchProbe.findTilesetIndex());
    if (idx >= 0) break;
    await sleep(500);
  }
  if (idx < 0) throw new Error('tileset not found in 45s');
  await page.evaluate(
    (a: { idx: number; msse: number }) => (window as any).BenchProbe.normalizeAndAnchor(a),
    { idx, msse },
  );
  const settleMs = Math.round(await settle(page, idx, 40000));
  const stats: any = await page.evaluate((i: number) => (window as any).BenchProbe.readStats(i), idx);
  const prof: any = await page.evaluate(
    (i: number) => (window as any).viewer.scene.primitives.get(i).copcProfile(),
    idx,
  );

  const decMs = prof.decodes.map((d: any) => d.decodeMs);
  const buildMs = prof.decodes.map((d: any) => d.buildMs);
  const resDur = prof.resTiming.map((r: any) => r.dur);
  const sumDec = sum(decMs),
    sumBuild = sum(buildMs),
    sumRes = sum(resDur);
  const conc = maxConcurrency(prof.resTiming);
  const bytes = prof.resTiming.reduce((a: number, r: any) => a + r.size, 0);

  console.log(`\n=== OURS deep-load 프로파일 (ds=${ds} msse=${msse} maxReq=${maxReq || 6} coalesce=${coalesce === '0' ? 'OFF' : 'ON'}, 실 GPU) ===`);
  console.log(`settle wall-clock : ${settleMs}ms   (pts=${stats.pointsSelected}, tilesReady=${stats.tilesReady}, 재시도=${retries})`);
  console.log(`decode 호출       : ${prof.decodes.length}`);
  console.log(`  decodeMs/tile   : p50=${pct(decMs, 50)} p95=${pct(decMs, 95)} max=${Math.max(...decMs, 0).toFixed(0)}  Σ=${sumDec.toFixed(0)}ms (S3 fetch+laz+reproject)`);
  console.log(`  buildMs/tile    : p50=${pct(buildMs, 50)} p95=${pct(buildMs, 95)}  Σ=${sumBuild.toFixed(0)}ms (pnts 빌드)`);
  console.log(`S3 range 요청     : ${prof.resTiming.length}개  Σ-dur=${sumRes.toFixed(0)}ms  bytes=${(bytes / 1e6).toFixed(1)}MB`);
  console.log(`  fetch dur/req   : p50=${pct(resDur, 50)} p95=${pct(resDur, 95)} max=${Math.max(...resDur, 0).toFixed(0)}ms`);
  console.log(`  달성 동시성     : ${conc}  (throttle=6)`);
  console.log(`\n--- 분해 ---`);
  console.log(`유효 동시성(Σdecode/settle) : ${(sumDec / settleMs).toFixed(2)}×  (6에 가까울수록 IO 동시성 포화)`);
  console.log(`fetch가 decode시간 차지     : ${((sumRes / sumDec) * 100).toFixed(0)}%  (높으면 네트워크 지배, 낮으면 laz/오버헤드)`);
  console.log(`build가 전체 차지           : ${((sumBuild / (sumDec + sumBuild)) * 100).toFixed(0)}%`);
  console.log(`요청당 평균 bytes           : ${prof.resTiming.length ? (bytes / prof.resTiming.length / 1024).toFixed(0) : 0}KB`);

  await ctx.close();
  await browser.close();
}
main().catch((e) => {
  console.error('fatal', e);
  process.exit(1);
});
