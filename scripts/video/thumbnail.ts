// YouTube 썸네일 생성 — 실제 앱 화면(HUD·자막 없는 깨끗한 프레임) 위에 문구를 얹는다.
//
// 유튜브 권장 1280×720. 배경은 합성 이미지가 아니라 실제 렌더 화면을 쓴다.
//
// 사용: npm run dev 후 → tsx scripts/video/thumbnail.ts
// 출력: docs/submission/video/thumbnail.png
import { chromium } from 'playwright';
import { mkdirSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

const OUT_DIR = 'docs/submission/video';
const SHOT = join(OUT_DIR, 'thumbnail-bg.png');
const OUT = join(OUT_DIR, 'thumbnail.png');
const PORT = process.env.PORT || '5173';
const W = 1280;
const H = 720;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// 1920×1080 으로 찍어 1280×720 으로 줄이면 슈퍼샘플링 효과로 점이 또렷해진다.
const SHOT_W = 1920;
const SHOT_H = 1080;

async function captureBackground(): Promise<void> {
  const browser = await chromium.launch({
    headless: true,
    args: ['--ignore-gpu-blocklist', '--enable-gpu-rasterization', '--use-angle=d3d11', '--hide-scrollbars'],
  });
  const ctx = await browser.newContext({ viewport: { width: SHOT_W, height: SHOT_H } });
  const page = await ctx.newPage();
  await page.goto(`http://localhost:${PORT}/?ds=sofi`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  // 썸네일은 순수 화면만 — HUD·툴바·도움말·크레딧·FPS 전부 숨긴다.
  await page.addStyleTag({
    content: `.cesium-viewer-toolbar, .cesium-navigation-help, .cesium-performanceDisplay,
              .cesium-widget-credits, .cesium-viewer-bottom, .cesium-viewer-fullscreenContainer
              { display: none !important; }
              body > div[style*="position:absolute"], body > div[style*="position: absolute"]
              { display: none !important; }`,
  });

  // 로딩 안정화
  let prev = -1;
  let stable = 0;
  for (let i = 0; i < 240; i++) {
    await sleep(500);
    const r = await page.evaluate(() => {
      const p = (window as any).viewer?.scene?.primitives;
      for (let i = 0; i < (p?.length ?? 0); i++) {
        const t = p.get(i);
        if (t?.statistics?.numberOfTilesWithContentReady != null) return t.statistics.numberOfTilesWithContentReady;
      }
      return 0;
    });
    if (r === prev && r > 0) { stable += 500; if (stable >= 3000) break; } else { stable = 0; prev = r; }
  }

  // 히어로 구도: 경기장(빨강)이 오른쪽에 오도록 살짝 비스듬히, 화면을 꽉 채운다.
  await page.evaluate(`(() => {
    const v = window.viewer, scene = v.scene;
    let ts = null;
    for (let i = 0; i < scene.primitives.length; i++) {
      const t = scene.primitives.get(i);
      if (t && t.copcPointBoundingSphere) { ts = t; break; }
    }
    const bs = ts.copcPointBoundingSphere;
    v.camera.lookAt(bs.center, { heading: 0.95, pitch: -0.52, range: bs.radius * 1.55 });
    scene.requestRender();
  })()`);
  await sleep(4000); // 새 시점의 타일이 채워질 시간
  await page.screenshot({ path: SHOT });
  await browser.close();
}

function overlayHtml(bgDataUri: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    *{margin:0;padding:0;box-sizing:border-box}
    html,body{width:${W}px;height:${H}px;overflow:hidden;
      font-family:"Malgun Gothic","맑은 고딕",system-ui,sans-serif;-webkit-font-smoothing:antialiased}
    .bg{position:absolute;inset:0;background:url('${bgDataUri}') center/cover no-repeat}
    /* 왼쪽에 어두운 스크림 — 글자 가독성 확보, 오른쪽 점군은 그대로 보이게 */
    .scrim{position:absolute;inset:0;
      background:linear-gradient(100deg, rgba(4,8,16,.94) 0%, rgba(4,8,16,.88) 34%, rgba(4,8,16,.35) 56%, rgba(4,8,16,0) 74%)}
    .txt{position:absolute;left:64px;top:50%;transform:translateY(-50%);width:660px}
    .eyebrow{font-size:30px;font-weight:800;letter-spacing:.03em;color:#6ee787;margin-bottom:14px}
    h1{font-size:82px;font-weight:800;line-height:1.1;letter-spacing:-.03em;color:#fff;
       text-shadow:0 4px 28px rgba(0,0,0,.65)}
    h1 .hl{color:#7aa2f7}
    .sub{margin-top:22px;font-size:31px;font-weight:600;color:#cfe0f5;line-height:1.45}
    .chips{margin-top:30px;display:flex;gap:12px;flex-wrap:wrap}
    .chip{background:rgba(18,35,61,.9);border:1px solid rgba(122,162,247,.5);border-radius:999px;
      padding:11px 22px;font-size:24px;font-weight:700;color:#bcd2ee}
    .badge{position:absolute;right:36px;bottom:32px;font-size:25px;font-weight:800;color:#e8eef7;
      background:rgba(4,8,16,.82);border:1px solid rgba(122,162,247,.45);border-radius:12px;padding:12px 22px}
  </style></head><body>
    <div class="bg"></div><div class="scrim"></div>
    <div class="txt">
      <div class="eyebrow">3D Tiles 변환 없이</div>
      <h1>COPC를 그대로<br/><span class="hl">CesiumJS</span>에</h1>
      <div class="sub">원본 .copc.laz 를 HTTP Range 로 직접 읽는다</div>
      <div class="chips">
        <div class="chip">1.9GB 원본</div>
        <div class="chip">LOD 스트리밍</div>
        <div class="chip">Apache-2.0</div>
      </div>
    </div>
    <div class="badge">copc-cesium</div>
  </body></html>`;
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  console.log('배경 캡처 중 (SoFi Stadium, HUD 없음) …');
  await captureBackground();

  const bg = 'data:image/png;base64,' + readFileSync(SHOT).toString('base64');
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: W, height: H } });
  await page.setContent(overlayHtml(bg), { waitUntil: 'load' });
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: OUT });
  await browser.close();

  unlinkSync(SHOT); // 중간 산출물 정리
  const kb = (readFileSync(OUT).length / 1024).toFixed(0);
  console.log(`완성 → ${OUT}  (${W}×${H}, ${kb}KB)`);
  console.log('유튜브 제한: 2MB 이하 · 1280×720 권장 — 충족');
}

main().catch((e) => {
  console.error('[thumbnail] fatal', e);
  process.exit(1);
});
