// 일회성 진단: settle 신호(pending/processing/tilesReady/pointsLength)의 시간 곡선을 관찰.
// "numberOfTilesProcessing이 0으로 떨어지는가? 실제 안정 시점은 언제인가?"를 측정으로 답한다.
// 사용: dev 서버를 먼저 띄운 뒤 `tsx scripts/bench/diag-settle.ts [ds] [msse]`
import { chromium } from 'playwright';
import { resolve } from 'path';
import { fileURLToPath } from 'url';

const PROBE_BUNDLE = resolve(fileURLToPath(import.meta.url), '../probe-bundle.js');
const ds = process.argv[2] || 'millsite';
const msse = Number(process.argv[3] || '8');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const browser = await chromium.launch({ headless: false });
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  page.on('console', (m) => {
    if (m.type() === 'error') console.log('[console:error]', m.text());
  });
  page.on('pageerror', (e) => console.log('[pageerror]', e.message));
  await page.addInitScript({ path: PROBE_BUNDLE });
  await page.goto(`http://localhost:5173/?ds=${ds}`, { waitUntil: 'domcontentloaded' });

  // tileset 등장 대기
  let idx = -1;
  const tStart = Date.now();
  while (Date.now() - tStart < 45000) {
    idx = await page.evaluate(() => (window as any).BenchProbe.findTilesetIndex());
    if (idx >= 0) break;
    await sleep(500);
  }
  if (idx < 0) throw new Error('tileset not found in 45s');
  console.log(`tileset idx=${idx}, anchoring msse=${msse} …`);
  await page.evaluate(
    (arg: { idx: number; msse: number }) => (window as any).BenchProbe.normalizeAndAnchor(arg),
    { idx, msse },
  );

  const t0 = Date.now();
  console.log('ms\tpending\tproc\ttilesReady\tptsLen\tptsSel\ttilesTotal');
  for (let i = 0; i < 160; i++) {
    const s: any = await page.evaluate(
      (i: number) => (window as any).BenchProbe.readStats(i),
      idx,
    );
    const ms = Date.now() - t0;
    console.log(
      `${ms}\t${s.pending}\t${s.processing}\t${s.tilesReady}\t${s.pointsLength}\t${s.pointsSelected}\t${s.tilesTotal}`,
    );
    await sleep(250);
  }
  await ctx.close();
  await browser.close();
}
main().catch((e) => {
  console.error('fatal', e);
  process.exit(1);
});
