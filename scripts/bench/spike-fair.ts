// scripts/bench/spike-fair.ts — 설계 리스크 3종 실측 (일회용)
import { chromium } from 'playwright';

const SOFI = 'https://hobu-lidar.s3.amazonaws.com/sofi.copc.laz';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const browser = await chromium.launch({
    headless: false,
    args: ['--disable-gpu-vsync', '--disable-frame-rate-limit'],
  });
  const page = await browser.newPage();

  // 리스크 1: vsync 해제 — Eptium 페이지에서 빈 rAF 루프 fps 측정
  await page.goto(`https://viewer.copc.io/?copc=${SOFI}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await sleep(8000);
  const fps: number = await page.evaluate(`
    (async () => {
      const s = (ms) => new Promise((r) => setTimeout(r, ms));
      const v = window.viewer;
      let n = 0, run = true;
      const loop = () => { n++; if (v?.scene?.requestRender) v.scene.requestRender(); if (run) requestAnimationFrame(loop); };
      requestAnimationFrame(loop);
      await s(2000); run = false;
      return n / 2;
    })()
  `);
  const vsyncUncapped = fps > 130; // 120Hz 천장이면 ~120, 해제면 그 이상

  // 리스크 2: Eptium config 제어/유지
  const configHolds: boolean = await page.evaluate(`
    (async () => {
      const s = (ms) => new Promise((r) => setTimeout(r, ms));
      const v = window.viewer;
      const pr = v.scene.primitives;
      let ts = null;
      for (let i = 0; i < pr.length; i++) { const p = pr.get(i); if (p && /Cesium3DTileset/.test(p.constructor?.name)) { ts = p; break; } }
      if (!ts || !ts.pointCloudShading) return false;
      ts.pointCloudShading.eyeDomeLighting = false;
      ts.pointCloudShading.attenuation = false;
      v.scene.requestRender(); await s(500); v.scene.requestRender(); await s(500);
      return ts.pointCloudShading.eyeDomeLighting === false && ts.pointCloudShading.attenuation === false;
    })()
  `);

  // 리스크 3: GPU timer query 가용성
  const gpuTimer: boolean = await page.evaluate(`
    (() => {
      const c = window.viewer?.canvas || document.querySelector('canvas');
      const gl = c?.getContext('webgl2');
      return !!gl?.getExtension('EXT_disjoint_timer_query_webgl2');
    })()
  `);

  // GPU 정체 — 서브에이전트 headed 브라우저가 실 Metal 받는지 (swiftshader면 fps/vsync 측정 무효)
  const glRenderer: string = await page.evaluate(`
    (() => {
      const c = window.viewer?.canvas || document.querySelector('canvas');
      const gl = c?.getContext('webgl2');
      const e = gl?.getExtension('WEBGL_debug_renderer_info');
      return e ? String(gl.getParameter(e.UNMASKED_RENDERER_WEBGL)) : 'unknown';
    })()
  `);

  console.log(`GL_RENDERER: ${glRenderer}`);
  console.log(`VSYNC_UNCAPPED: ${vsyncUncapped} (fps=${fps})`);
  console.log(`EPTIUM_CONFIG_HOLDS: ${configHolds}`);
  console.log(`GPU_TIMER_AVAILABLE: ${gpuTimer}`);
  await browser.close();
}
main().catch((e) => { console.error(e); process.exit(1); });
