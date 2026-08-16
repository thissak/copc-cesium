import { mkdir, rename, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { chromium } from 'playwright';

const projectRoot = resolve(import.meta.dirname, '../..');
const datasetId = process.env.COPC_DEMO_ID ?? 'millsite';
const outputPath = resolve(
  projectRoot,
  `docs/submission/video/assets/raw/${datasetId}-demo.webm`,
);
const captureDir = resolve(projectRoot, 'docs/submission/video/assets/raw/playwright');
// Vite 8 은 localhost(IPv6)에만 바인딩한다 — 127.0.0.1 로 두면 연결이 안 된다.
const demoUrl = process.env.COPC_DEMO_URL ?? `http://localhost:5173/?ds=${datasetId}`;
const warmupMs = datasetId === 'autzen' ? 10_000 : 16_000;

await mkdir(dirname(outputPath), { recursive: true });
await mkdir(captureDir, { recursive: true });

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  viewport: { width: 1920, height: 1080 },
  deviceScaleFactor: 1,
  recordVideo: {
    dir: captureDir,
    size: { width: 1920, height: 1080 },
  },
});
const page = await context.newPage();
page.on('console', (message) => {
  if (message.type() === 'error') console.error(`[browser] ${message.text()}`);
});
page.on('pageerror', (error) => console.error(`[page] ${error.message}`));

await page.goto(demoUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
await page.waitForFunction(
  () => {
    const viewer = window.viewer;
    return viewer?.scene?.primitives?.length > 0;
  },
  undefined,
  { timeout: 60_000 },
);

// 첫 타일이 화면에 자리 잡을 시간을 준 뒤, 디버그 UI만 감추고 실제 렌더링 화면을 녹화한다.
await page.waitForTimeout(warmupMs);
await page.addStyleTag({
  content: `
    .cesium-viewer-bottom,
    .cesium-viewer-toolbar,
    .cesium-navigation-help,
    .cesium-navigation-help-button-wrapper,
    .cesium-viewer-fullscreenContainer,
    #pick-panel { display: none !important; }
  `,
});
await page.evaluate(() => {
  const viewer = window.viewer;
  viewer.scene.debugShowFramesPerSecond = false;
  viewer.scene.requestRenderMode = false;
  for (const element of document.body.children) {
    if (element instanceof HTMLElement && element.style.zIndex === '999') {
      element.style.display = 'none';
    }
  }
});

async function orbit({ seconds, headingFrom, headingTo, pitchFrom, pitchTo, rangeFrom, rangeTo }) {
  await page.evaluate(
    ({ seconds, headingFrom, headingTo, pitchFrom, pitchTo, rangeFrom, rangeTo }) =>
      new Promise((resolveAnimation) => {
        const viewer = window.viewer;
        const tileset = viewer.scene.primitives.get(0);
        const sphere = tileset.boundingSphere;
        const startedAt = performance.now();
        const ease = (t) => t * t * (3 - 2 * t);
        const frame = () => {
          const progress = Math.min(1, (performance.now() - startedAt) / (seconds * 1000));
          const t = ease(progress);
          viewer.camera.lookAt(sphere.center, {
            heading: headingFrom + (headingTo - headingFrom) * t,
            pitch: pitchFrom + (pitchTo - pitchFrom) * t,
            range: sphere.radius * (rangeFrom + (rangeTo - rangeFrom) * t),
          });
          viewer.scene.requestRender();
          if (progress < 1) requestAnimationFrame(frame);
          else resolveAnimation();
        };
        requestAnimationFrame(frame);
      }),
    { seconds, headingFrom, headingTo, pitchFrom, pitchTo, rangeFrom, rangeTo },
  );
}

// 넓은 전체 뷰 → 근접 LOD → 반대편 전체 뷰. 카메라가 움직일 때 원본 COPC의
// 필요한 노드가 추가로 채워지는 모습을 그대로 담는다.
await orbit({
  seconds: 2,
  headingFrom: -0.8,
  headingTo: -0.8,
  pitchFrom: -0.55,
  pitchTo: -0.55,
  rangeFrom: 1.8,
  rangeTo: 1.8,
});
await page.waitForTimeout(4_000);
await orbit({
  seconds: 12,
  headingFrom: -0.8,
  headingTo: 0.35,
  pitchFrom: -0.55,
  pitchTo: -0.7,
  rangeFrom: 1.8,
  rangeTo: 1.05,
});
await page.waitForTimeout(6_000);
await orbit({
  seconds: 14,
  headingFrom: 0.35,
  headingTo: 2.2,
  pitchFrom: -0.7,
  pitchTo: -0.48,
  rangeFrom: 1.05,
  rangeTo: 0.68,
});
await page.waitForTimeout(6_000);
await orbit({
  seconds: 11,
  headingFrom: 2.2,
  headingTo: 3.25,
  pitchFrom: -0.48,
  pitchTo: -0.62,
  rangeFrom: 0.68,
  rangeTo: 1.45,
});
await page.waitForTimeout(3_000);

const video = page.video();
await context.close();
await browser.close();

const recordedPath = await video.path();
await rm(outputPath, { force: true });
await rename(recordedPath, outputPath);
console.log(JSON.stringify({ datasetId, outputPath }));
