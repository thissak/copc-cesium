// scripts/bench/fair-compare.ts
import { chromium, type Browser, type Page } from 'playwright';
import { resolve } from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import type { ViewerCurve } from './fair-types';
import { renderFairReport } from './fair-report';

const BUNDLE = resolve(fileURLToPath(import.meta.url), '../fair-probe-bundle.js');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const MSSE = 2;          // 낮은 msse → 깊은 refine → 넓은 점 범위 로드(곡선 overlap↑)
const BUCKET = 250_000;  // pointsSelected 버킷 크기
const CAP = 90_000;      // 곡선 측정 상한(ms)

const DATASETS: Record<string, { id: string; copcUrl: string }> = {
  millsite: { id: 'millsite', copcUrl: 'https://s3.amazonaws.com/hobu-lidar/millsite.copc.laz' },
  sofi: { id: 'sofi', copcUrl: 'https://hobu-lidar.s3.amazonaws.com/sofi.copc.laz' },
};

export async function measureViewer(browser: Browser, label: 'ours' | 'eptium', url: string): Promise<ViewerCurve> {
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 900 } });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log(`[${label}-pageerror]`, e.message));
  await page.addInitScript({ path: BUNDLE });
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  let idx = -1;
  for (let i = 0; i < 90 && idx < 0; i++) { await sleep(500); idx = await page.evaluate(() => (window as any).FairProbe.findTilesetIndex()); }
  if (idx < 0) throw new Error(`${label}: tileset not found within 45s`);
  const glRenderer: string = await page.evaluate(() => { const c: any = (window as any).viewer?.canvas; const gl: any = c?.getContext('webgl2'); const e = gl?.getExtension('WEBGL_debug_renderer_info'); return e ? gl.getParameter(e.UNMASKED_RENDERER_WEBGL) : 'unknown'; });
  await page.evaluate((i) => (window as any).FairProbe.normalizeConfig(i), idx);
  await page.evaluate((i) => (window as any).FairProbe.setViewpoint(i), idx);
  if (!(await page.evaluate((i) => (window as any).FairProbe.assertConfig(i), idx)))
    throw new Error(`${label}: config normalization failed (readback mismatch)`);
  // 깊은 로드가 실제 시작될 때까지 대기 — pts가 BUCKET 넘을 때까지(plateau 조기발동 방지, Task6 concern).
  for (let i = 0; i < 60; i++) { const s: any = await page.evaluate((x) => (window as any).FairProbe.readStats(x), idx); if (s.pointsSelected > BUCKET) break; await sleep(500); }
  const reassert = label === 'eptium';
  const r: any = await page.evaluate((a) => (window as any).FairProbe.measureLoadCurve(a.i, a.m, a.cap, a.bk, a.r), { i: idx, m: MSSE, cap: CAP, bk: BUCKET, r: reassert });
  await ctx.close();
  return { label, glRenderer, gpuOk: r.gpuOk, finalPts: r.finalPts, curve: r.curve };
}
