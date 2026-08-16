// 이슈 #28 재현 — `viewer.zoomTo(tileset)` 초기 시점이 점군을 화면 중앙에 두는지 잰다.
// 가설: tileset.boundingSphere 는 COPC 옥트리 *큐브*에서 파생되고, 점은 큐브 바닥에만 있으므로
//       zoomTo 는 점군보다 한참 위를 조준한다 → 점군이 화면 하단으로 밀린다.
// 판정: 캔버스에서 점군 픽셀의 화면좌표 중심 cy 가 뷰포트 중앙(0.5)에서 얼마나 벗어나는가.
//       배경(지구본·하늘·태양)을 끄면 남는 비검정 픽셀 = 점군이므로 렌더 결과를 직접 잰다.
//
// 사용: dev 서버 먼저(`npm run dev`) → `tsx scripts/bench/repro-28.ts [ds=autzen]`
import { chromium } from 'playwright';

const ds = process.argv[2] || 'autzen';
const PORT = process.env.PORT || '5173';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const CENTER_TOL = 0.12; // 뷰포트 높이 대비 허용 이탈 (|cy - 0.5|)
const MIN_COVERAGE = 0.04; // 점군이 최소 이만큼은 화면을 채워야 "프레이밍됐다"고 본다

type Metrics = {
  cx: number;
  cy: number;
  coverage: number;
  bbox: { x0: number; y0: number; x1: number; y1: number };
  pixels: number;
};

async function main() {
  const browser = await chromium.launch({ headless: false, args: ['--ignore-gpu-blocklist'] });
  const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log('[pageerror]', e.message.slice(0, 200)));
  await page.goto(`http://localhost:${PORT}/?ds=${ds}`, { waitUntil: 'domcontentloaded', timeout: 60000 });

  // 로드 안정화 — tilesReady 가 멎을 때까지
  let prev = -1;
  let stable = 0;
  let ready = 0;
  for (let i = 0; i < 160; i++) {
    await sleep(500);
    ready = await page.evaluate(() => {
      const p = (window as any).viewer?.scene?.primitives;
      for (let i = 0; i < (p?.length ?? 0); i++) {
        const t = p.get(i);
        if (t?.statistics?.numberOfTilesWithContentReady != null) return t.statistics.numberOfTilesWithContentReady;
      }
      return 0;
    });
    if (ready === prev && ready > 0) {
      stable += 500;
      if (stable >= 2500) break;
    } else {
      stable = 0;
      prev = ready;
    }
  }
  if (ready <= 0) throw new Error('타일이 하나도 준비되지 않았다 — 재현 불가');

  // 배경 제거: 남는 비검정 픽셀 = 점군.
  const tilesetBs = await page.evaluate(() => {
    const v = (window as any).viewer;
    const s = v.scene;
    s.globe.show = false;
    if (s.skyBox) s.skyBox.show = false;
    if (s.skyAtmosphere) s.skyAtmosphere.show = false;
    if (s.sun) s.sun.show = false;
    if (s.moon) s.moon.show = false;
    s.backgroundColor = s.backgroundColor.constructor.BLACK;
    s.requestRender();
    let ts: any = null;
    for (let i = 0; i < s.primitives.length; i++) {
      const t = s.primitives.get(i);
      if (t?.boundingSphere && t?.statistics) { ts = t; break; }
    }
    const g = s.globe.ellipsoid.cartesianToCartographic(ts.boundingSphere.center);
    return { h: +g.height.toFixed(1), radius: +ts.boundingSphere.radius.toFixed(1) };
  });
  await sleep(1200);

  // 캔버스 위에 겹친 DOM(HUD·툴바·도움말·크레딧)을 숨긴다 — 안 숨기면 그 픽셀이 점군으로 오계수된다.
  await page.addStyleTag({
    content: `.cesium-viewer-toolbar, .cesium-navigation-help, .cesium-widget-credits,
              .cesium-viewer-bottom, .cesium-viewer-fullscreenContainer { display: none !important; }
              body > div[style*="position:absolute"], body > div[style*="position: absolute"] { display: none !important; }`,
  });
  await sleep(400);

  // 캔버스만 캡처 → 페이지 안에서 2D 캔버스로 픽셀 스캔
  const shot = (await page.locator('canvas').first().screenshot()).toString('base64');
  const m: Metrics = await page.evaluate(async (b64: string) => {
    const img = new Image();
    img.src = 'data:image/png;base64,' + b64;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = img.naturalWidth;
    c.height = img.naturalHeight;
    const g = c.getContext('2d')!;
    g.drawImage(img, 0, 0);
    const { data } = g.getImageData(0, 0, c.width, c.height);
    let sx = 0, sy = 0, n = 0;
    let x0 = c.width, y0 = c.height, x1 = -1, y1 = -1;
    for (let y = 0; y < c.height; y++) {
      for (let x = 0; x < c.width; x++) {
        const i = (y * c.width + x) * 4;
        // 비배경 판정: 배경은 순검정. 압축 노이즈 여유로 10 임계.
        if (data[i] > 10 || data[i + 1] > 10 || data[i + 2] > 10) {
          sx += x; sy += y; n++;
          if (x < x0) x0 = x;
          if (y < y0) y0 = y;
          if (x > x1) x1 = x;
          if (y > y1) y1 = y;
        }
      }
    }
    if (!n) return { cx: -1, cy: -1, coverage: 0, bbox: { x0: 0, y0: 0, x1: 0, y1: 0 }, pixels: 0 };
    return {
      cx: +(sx / n / c.width).toFixed(4),
      cy: +(sy / n / c.height).toFixed(4),
      coverage: +(n / (c.width * c.height)).toFixed(4),
      bbox: { x0: +(x0 / c.width).toFixed(3), y0: +(y0 / c.height).toFixed(3), x1: +(x1 / c.width).toFixed(3), y1: +(y1 / c.height).toFixed(3) },
      pixels: n,
    };
  }, shot);

  const offCenter = Math.abs(m.cy - 0.5);
  const centered = m.pixels > 0 && offCenter <= CENTER_TOL;
  const filled = m.coverage >= MIN_COVERAGE;
  const pass = centered && filled;

  console.log(`[repro-28] ds=${ds} tilesReady=${ready}`);
  console.log(`  tileset.boundingSphere: 중심고도 ${tilesetBs.h}m  반경 ${tilesetBs.radius}m`);
  console.log(`  점군 화면중심   cx=${m.cy === -1 ? 'n/a' : m.cx} cy=${m.cy === -1 ? 'n/a' : m.cy}   (중앙 이탈 ${offCenter.toFixed(4)} / 허용 ${CENTER_TOL})`);
  console.log(`  점군 화면bbox   y ${m.bbox.y0}~${m.bbox.y1}   x ${m.bbox.x0}~${m.bbox.x1}`);
  console.log(`  화면 점유율     ${(m.coverage * 100).toFixed(2)}%   (최소 ${(MIN_COVERAGE * 100).toFixed(0)}%)`);
  console.log(`  판정: ${pass ? 'PASS — 점군이 화면 중앙에 잡힘' : 'FAIL — ' + (!filled ? '점군이 화면을 거의 못 채움' : '점군이 중앙에서 벗어남')}`);

  await browser.close();
  process.exit(pass ? 0 : 1);
}

main().catch((e) => {
  console.error('[repro-28] fatal', e);
  process.exit(2);
});
