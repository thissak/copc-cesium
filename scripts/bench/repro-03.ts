// 이슈 #03 재현/회귀 테스트 — numberOfTilesProcessing 영구 고착(빈 노드 0점 pnts → Model PROCESSING 고착).
// 수정 前(RED): 뷰 완성 + 8s 후에도 tilesLoaded=false, allTilesLoaded 미fire, processing>0.
// 수정 後(GREEN): 빈 노드를 404→Cesium missingTilePolicy→Empty3DTileContent 로 ready → processing=0, tilesLoaded=true.
// 사용: dev 서버를 먼저 띄운 뒤 `tsx scripts/bench/repro-03.ts [ds] [msse]` (exit 0=GREEN, 1=버그 재발)
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

  let idx = -1;
  const tStart = Date.now();
  while (Date.now() - tStart < 45000) {
    idx = await page.evaluate(() => (window as any).BenchProbe.findTilesetIndex());
    if (idx >= 0) break;
    await sleep(500);
  }
  if (idx < 0) throw new Error('tileset not found in 45s');

  // settle 전에 이벤트 리스너 설치
  await page.evaluate((i: number) => (window as any).BenchProbe.watchTilesLoaded(i), idx);
  await page.evaluate(
    (arg: { idx: number; msse: number }) => (window as any).BenchProbe.normalizeAndAnchor(arg),
    { idx, msse },
  );
  console.log(`tileset idx=${idx}, anchored msse=${msse} (ds=${ds}). settle 대기 …`);

  // 실제 settle: pending=0 && tilesReady 3초 안정 (issue #01 fix와 동일 신호)
  let prevReady = -1;
  let stableMs = 0;
  let settleMs = -1;
  const s0 = Date.now();
  while (Date.now() - s0 < 30000) {
    const s: any = await page.evaluate((i: number) => (window as any).BenchProbe.readStats(i), idx);
    const settled = s.pending === 0 && (s.tilesReady > 0 || s.pointsLength > 0);
    const key = s.tilesReady > 0 ? s.tilesReady : s.pointsLength;
    if (settled && key === prevReady) {
      stableMs += 250;
      if (stableMs >= 3000) {
        settleMs = Date.now() - s0 - stableMs;
        break;
      }
    } else {
      stableMs = 0;
      prevReady = key;
    }
    await sleep(250);
  }
  console.log(`settle 도달: ~${settleMs}ms (pending=0 & tilesReady 안정). 이후 8초 더 관찰 …`);

  // settle 후 8초 더 — processing이 늦게라도 빠지는지 확인
  await sleep(8000);

  const r: any = await page.evaluate((i: number) => (window as any).BenchProbe.inspectTiles(i), idx);
  console.log('\n=== inspectTiles (settle + 8s) ===');
  console.log(`tilesLoaded            = ${r.tilesLoaded}`);
  console.log(`allTilesLoadedFired    = ${r.allTilesLoadedFired}`);
  console.log(`initialTilesLoadedFired= ${r.initialTilesLoadedFired}`);
  console.log(`numberOfTilesProcessing= ${r.processing}  (pending=${r.pending}, tilesReady=${r.tilesReady})`);
  console.log(`tree visited           = ${r.visited}`);
  console.log(`content state 분포 (state:count) = ${JSON.stringify(r.byState)}`);
  console.log(`PROCESSING/미완 타일 수 = ${r.stuck.length}`);
  console.log('고착 타일 상세:');
  for (const t of r.stuck) console.log('  ', JSON.stringify(t));

  // 회귀 판정: 수정 유지(GREEN)면 PASS, 고착 재발(RED)이면 FAIL.
  const fixed = r.tilesLoaded === true && r.allTilesLoadedFired === true && r.processing === 0;
  console.log(
    `\n[REPRO #03] ${fixed ? 'PASS ✓ — tilesLoaded=true · allTilesLoaded fire · processing=0 (빈 노드=Empty3DTileContent)' : 'FAIL ✗ — tilesLoaded/allTilesLoaded 미도달 또는 processing 고착 (#03 재발)'}`,
  );

  await ctx.close();
  await browser.close();
  process.exit(fixed ? 0 : 1); // 0=GREEN(수정 유지), 1=RED(버그 재발)
}
main().catch((e) => {
  console.error('fatal', e);
  process.exit(1);
});
