import { mkdir, rename, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { chromium } from 'playwright';
import { totalDuration } from '../../docs/submission/video/composition/timeline.js';

const projectRoot = resolve(import.meta.dirname, '../..');
const outputPath = resolve(projectRoot, 'docs/submission/video/assets/render/visual-master.webm');
const captureDir = resolve(projectRoot, 'docs/submission/video/assets/render/playwright');
const compositionUrl =
  process.env.COPC_COMPOSITION_URL ??
  'http://127.0.0.1:5173/docs/submission/video/composition/index.html';

await mkdir(dirname(outputPath), { recursive: true });
await mkdir(captureDir, { recursive: true });

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  viewport: { width: 1920, height: 1080 },
  deviceScaleFactor: 1,
  recordVideo: { dir: captureDir, size: { width: 1920, height: 1080 } },
});
const page = await context.newPage();
page.on('pageerror', (error) => console.error(`[page] ${error.message}`));

await page.goto(compositionUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
await page.waitForFunction(() => window.__compositionReady, undefined, { timeout: 30_000 });
await page.evaluate(() => window.__compositionReady);
await page.evaluate(() => window.startComposition());
await page.waitForFunction(() => window.__compositionDone === true, undefined, {
  timeout: (totalDuration + 30) * 1000,
});

const video = page.video();
await context.close();
await browser.close();
const recordedPath = await video.path();
await rm(outputPath, { force: true });
await rename(recordedPath, outputPath);
console.log(JSON.stringify({ outputPath, totalDuration }));
