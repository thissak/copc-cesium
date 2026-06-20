// scripts/bench/fair-compare.ts
import { chromium, type Browser, type Page } from 'playwright';
import { resolve } from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import type { ViewerCurve, CurvePoint } from './fair-types';
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

async function ensureDevServer(): Promise<() => void> {
  const ok = async () => { try { return (await fetch('http://localhost:5173')).status < 500; } catch { return false; } };
  if (await ok()) return () => {};
  const child = spawn('npx', ['vite', '--port', '5173'], { cwd: process.cwd(), stdio: 'ignore' });
  for (let i = 0; i < 60; i++) { await sleep(500); if (await ok()) return () => child.kill(); }
  child.kill(); throw new Error('dev server failed on :5173');
}

// 공통 점 버킷에서 ours/eptium GPU ms 비교
function alignAndRatio(a: ViewerCurve, b: ViewerCurve, floor: number) {
  const threshold = Math.max(0.10, floor);
  const bMap = new Map(b.curve.map((p: CurvePoint) => [p.pts, p.gpuMs]));
  const rows: any[] = [];
  for (const pa of a.curve) {
    const gb = bMap.get(pa.pts);
    if (gb == null) continue; // 겹치는 버킷만
    const ratio = pa.gpuMs / gb;
    const verdict = Math.abs(ratio - 1) <= threshold ? '동급' : ratio < 1 ? '우위(우리가 빠름)' : '열위(우리가 느림)';
    rows.push({ pts: pa.pts, oursGpuMs: pa.gpuMs, eptiumGpuMs: gb, ratio: +ratio.toFixed(3), verdict });
  }
  return rows;
}

// 영실험: 두 곡선의 공통 버킷 상대차 최대값 = 노이즈바닥
function noiseFloor(a: ViewerCurve, b: ViewerCurve): number {
  const bMap = new Map(b.curve.map((p: CurvePoint) => [p.pts, p.gpuMs]));
  let maxRel = 0;
  for (const pa of a.curve) { const gb = bMap.get(pa.pts); if (gb == null) continue; maxRel = Math.max(maxRel, Math.abs(pa.gpuMs - gb) / ((pa.gpuMs + gb) / 2)); }
  return +maxRel.toFixed(3);
}

async function main() {
  const NULL_MAX = 0.20; // 도구 자체 ours-vs-ours 노이즈 상한
  const ds = process.argv.includes('--ds') ? process.argv[process.argv.indexOf('--ds') + 1] : 'sofi';
  if (!DATASETS[ds]) throw new Error(`unknown --ds ${ds}`);
  const browser = await chromium.launch({ headless: false });
  const stopDev = await ensureDevServer();
  try {
    const oursUrl = `http://localhost:5173/?ds=${ds}`;
    const eptiumUrl = `https://viewer.copc.io/?copc=${DATASETS[ds].copcUrl}`;

    // 영실험 (ours vs ours)
    const nullA = await measureViewer(browser, 'ours', oursUrl);
    const nullB = await measureViewer(browser, 'ours', oursUrl);
    const floor = noiseFloor(nullA, nullB);
    const nullRows = alignAndRatio(nullA, nullB, floor);
    const nullOk = nullRows.length >= 3 && floor <= NULL_MAX;

    // 본 측정
    const ours = await measureViewer(browser, 'ours', oursUrl);
    const eptium = await measureViewer(browser, 'eptium', eptiumUrl);
    const verdict = alignAndRatio(ours, eptium, floor);

    const gates = {
      gpuMsOk: ours.gpuOk && eptium.gpuOk,
      configHeld: true, // measureViewer 가 실패 시 throw → 여기 도달=held
      overlapOk: verdict.length >= 3,
      nullTestOk: nullOk,
    };

    mkdirSync('docs/bench', { recursive: true });
    const md = renderFairReport({ ds, ours, eptium, verdict, floor, gates, nullOk });
    writeFileSync(`docs/bench/fair-compare-${ds}.md`, md);
    writeFileSync(`docs/bench/fair-compare-${ds}.json`, JSON.stringify({ ds, ours, eptium, verdict, floor, gates }, null, 2));
    console.log(`[fair] wrote docs/bench/fair-compare-${ds}.{md,json}  nullOk=${nullOk} floor=${floor} overlap=${verdict.length}`);
  } finally { await browser.close(); stopDev(); }
}
main().catch((e) => { console.error('[fair] fatal', e); process.exit(1); });
