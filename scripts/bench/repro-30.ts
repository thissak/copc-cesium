// 이슈 #30 재현 — 고도색 램프가 이상치에 무너져 점군이 단색이 되는지 잰다.
// 가설: 색 범위를 LAS header 원시 min/max 로 잡으면 바닥/천장 노이즈 몇 점이 램프를 지배해
//       실제 지형이 좁은 색 구간(단일 hue)으로 압축된다.
// 판정: 배경(지구본·하늘)을 끈 캔버스에서 점군 픽셀의 **색상(hue) 분포**를 본다.
//       한 hue 버킷에 쏠려 있으면 램프가 무너진 것.
//
// 사용: dev 서버 먼저(`npm run dev`) → `tsx scripts/bench/repro-30.ts [ds=sofi]`
import { chromium } from 'playwright';

const ds = process.argv[2] || 'sofi';
const PORT = process.env.PORT || '5173';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// 색 램프는 hslToRgb((1-t)*0.66, …) 이므로 정상이면 파랑(≈238°)→빨강(0°) 약 238° 를 훑는다.
// 인접 버킷 개수만 세면 "전부 초록"도 여러 버킷으로 잡히므로(1차 지표의 실패), 색상환에서
// 유채색 픽셀의 90% 를 덮는 **최소 호(arc) 길이**로 잰다 — 뭉쳐 있으면 호가 짧다.
const MIN_HUE_SPAN_DEG = 90; // 90% 픽셀을 덮는 호가 이보다 좁으면 단색으로 무너진 것

async function main() {
  const browser = await chromium.launch({ headless: true, args: ['--ignore-gpu-blocklist', '--use-angle=d3d11'] });
  const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log('[pageerror]', e.message.slice(0, 200)));
  await page.goto(`http://localhost:${PORT}/?ds=${ds}`, { waitUntil: 'domcontentloaded', timeout: 60000 });

  let prev = -1;
  let stable = 0;
  let ready = 0;
  for (let i = 0; i < 240; i++) {
    await sleep(500);
    ready = await page.evaluate(() => {
      const p = (window as any).viewer?.scene?.primitives;
      for (let i = 0; i < (p?.length ?? 0); i++) {
        const t = p.get(i);
        if (t?.statistics?.numberOfTilesWithContentReady != null) return t.statistics.numberOfTilesWithContentReady;
      }
      return 0;
    });
    if (ready === prev && ready > 0) { stable += 500; if (stable >= 3000) break; } else { stable = 0; prev = ready; }
  }
  if (ready <= 0) throw new Error('타일이 준비되지 않았다 — 재현 불가');

  // 배경 제거 → 남는 비검정 픽셀 = 점군. DOM 오버레이도 숨겨 오계수를 막는다.
  await page.evaluate(() => {
    const s = (window as any).viewer.scene;
    s.globe.show = false;
    if (s.skyBox) s.skyBox.show = false;
    if (s.skyAtmosphere) s.skyAtmosphere.show = false;
    if (s.sun) s.sun.show = false;
    if (s.moon) s.moon.show = false;
    s.backgroundColor = s.backgroundColor.constructor.BLACK;
    s.requestRender();
  });
  await page.addStyleTag({
    content: `.cesium-viewer-toolbar, .cesium-navigation-help, .cesium-widget-credits,
              .cesium-viewer-bottom, .cesium-performanceDisplay { display: none !important; }
              body > div[style*="position:absolute"], body > div[style*="position: absolute"] { display: none !important; }`,
  });
  await sleep(1200);

  const shot = (await page.locator('canvas').first().screenshot()).toString('base64');
  const m = await page.evaluate(async (b64: string) => {
    const img = new Image();
    img.src = 'data:image/png;base64,' + b64;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = img.naturalWidth;
    c.height = img.naturalHeight;
    const g = c.getContext('2d')!;
    g.drawImage(img, 0, 0);
    const { data } = g.getImageData(0, 0, c.width, c.height);
    const BUCKETS = 36; // 10도 단위
    const hist = new Array<number>(BUCKETS).fill(0);
    let n = 0;
    let grey = 0;
    for (let i = 0; i < data.length; i += 4) {
      const r = data[i], gg = data[i + 1], b = data[i + 2];
      if (r <= 10 && gg <= 10 && b <= 10) continue; // 배경
      n++;
      const mx = Math.max(r, gg, b), mn = Math.min(r, gg, b);
      const d = mx - mn;
      if (d < 12) { grey++; continue; } // 무채색은 hue 무의미
      let h: number;
      if (mx === r) h = ((gg - b) / d) % 6;
      else if (mx === gg) h = (b - r) / d + 2;
      else h = (r - gg) / d + 4;
      h = ((h * 60) % 360 + 360) % 360;
      hist[Math.min(BUCKETS - 1, Math.floor(h / (360 / BUCKETS)))]++;
    }
    const colored = n - grey;
    // 색상환에서 90% 를 덮는 최소 호: 모든 시작 버킷에 대해 누적 90% 에 닿는 길이의 최솟값.
    const need = colored * 0.9;
    let bestLen = BUCKETS;
    for (let start = 0; start < BUCKETS; start++) {
      let acc = 0;
      let len = 0;
      while (len < BUCKETS && acc < need) { acc += hist[(start + len) % BUCKETS]; len++; }
      if (acc >= need && len < bestLen) bestLen = len;
    }
    const top = Math.max(...hist);
    return {
      pixels: n,
      colored,
      hueSpanDeg: bestLen * (360 / BUCKETS),
      dominantFrac: +(top / Math.max(1, colored)).toFixed(4),
      dominantHueDeg: hist.indexOf(top) * 10,
    };
  }, shot);

  const pass = m.colored > 0 && m.hueSpanDeg >= MIN_HUE_SPAN_DEG;
  console.log(`[repro-30] ds=${ds} tilesReady=${ready}`);
  console.log(`  점군 픽셀        ${m.pixels.toLocaleString()} (유채색 ${m.colored.toLocaleString()})`);
  console.log(`  hue 스팬(90%)    ${m.hueSpanDeg}°   (최소 ${MIN_HUE_SPAN_DEG}°)`);
  console.log(`  최다 hue         ${m.dominantFrac} @ ${m.dominantHueDeg}°`);
  console.log(`  판정: ${pass ? 'PASS — 색이 고도에 따라 퍼짐' : 'FAIL — 램프가 단색으로 무너짐'}`);

  await browser.close();
  process.exit(pass ? 0 : 1);
}

main().catch((e) => {
  console.error('[repro-30] fatal', e);
  process.exit(2);
});
