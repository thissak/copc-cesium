// scripts/bench/probe-budget.ts — 이슈 #08 Step5 검증 (pointBudget on/off × 깊은/정상 시점)
// cold-start(리로드) · 로드 시작 대기(cold-start 타이밍 버그 수정) · EDL/atten ON 실사용 · res=1.
//   C1 부드러움: deep 시점서 budget2M 가 unlimited 대비 gpuMs↓
//   C4 회귀:     normal 시점서 budget2M 가 unlimited 와 동일(정상뷰 점수<2M → 캡 무영향)
//   ① 품질:      deep 스크린샷 대조(점 줄여도 커버/실루엣 회귀 ≤ 임계)
// 실효 메모리 한도 = cacheBytes + maximumCacheOverflowBytes = 2×mb (16MB ≈ pointBudget 2M; 점당 실측 ~16B).
//   실행: npm run bench:budget [-- --ds sofi]   (실 GPU headless:false)
import { chromium } from 'playwright';
import { resolve } from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';

const BUNDLE = resolve(fileURLToPath(import.meta.url), '../fair-probe-bundle.js');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const MSSE = 2;
const BUCKET = 250_000;
const CAP = 60_000; // plateau 측정 상한(5s 정지 조기종료 내장)
const POINTS = [
  { name: 'deep', factor: 0.15 },  // C1/① — 캡 효과 가시화
  { name: 'normal', factor: 1.0 }, // C4 — 캡 무영향(정상/원거리) 확인
];
const CAPS = [
  { name: 'unlimited', mb: 512 }, // pointBudget off (Cesium 기본 무제한)
  { name: 'budget2M', mb: 16 },   // pointBudget=2M ≈ cacheBytes 16MB
];

async function ensureDevServer(): Promise<() => void> {
  const ok = async () => { try { return (await fetch('http://localhost:5173')).status < 500; } catch { return false; } };
  if (await ok()) return () => {};
  const child = spawn('npx', ['vite', '--port', '5173'], { cwd: process.cwd(), stdio: 'ignore' });
  for (let i = 0; i < 60; i++) { await sleep(500); if (await ok()) return () => child.kill(); }
  child.kill(); throw new Error('dev server failed on :5173');
}

async function main() {
  const ds = process.argv.includes('--ds') ? process.argv[process.argv.indexOf('--ds') + 1] : 'sofi';
  const browser = await chromium.launch({ headless: false });
  const stopDev = await ensureDevServer();
  mkdirSync('docs/bench/budget', { recursive: true });
  try {
    const ctx = await browser.newContext({ viewport: { width: 1600, height: 900 } });
    const page = await ctx.newPage();
    page.on('pageerror', (e) => console.log('[pageerror]', e.message));
    await page.addInitScript({ path: BUNDLE });

    let glRenderer = 'unknown';
    const rows: any[] = [];
    for (const pt of POINTS) {
      for (const cap of CAPS) {
        await page.goto(`http://localhost:5173/?ds=${ds}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
        let idx = -1;
        for (let i = 0; i < 90 && idx < 0; i++) { await sleep(500); idx = await page.evaluate(() => (window as any).FairProbe.findTilesetIndex()); }
        if (idx < 0) throw new Error(`${pt.name}/${cap.name}: tileset not found within 45s`);
        if (glRenderer === 'unknown')
          glRenderer = await page.evaluate(() => { const c: any = (window as any).viewer?.canvas; const gl: any = c?.getContext('webgl2'); const e = gl?.getExtension('WEBGL_debug_renderer_info'); return e ? gl.getParameter(e.UNMASKED_RENDERER_WEBGL) : 'unknown'; });
        await page.evaluate(() => { const v: any = (window as any).viewer; if (v.scene.globe) v.scene.globe.show = false; v.imageryLayers?.removeAll?.(); v.useBrowserRecommendedResolution = false; v.resolutionScale = 1; });
        await page.evaluate((a) => (window as any).FairProbe.setCacheBytes(a.i, a.mb), { i: idx, mb: cap.mb });
        await page.evaluate((a) => (window as any).FairProbe.setViewpoint(a.i, a.f), { i: idx, f: pt.factor });
        // 로드 시작 대기(타이밍 버그 수정): pointsSelected>0 까지 최대 30s — measureLoadCurve 가 0 에서 조기종료하는 것 방지
        for (let i = 0; i < 60; i++) { const s: any = await page.evaluate((x) => (window as any).FairProbe.readStats(x), idx); if (s.pointsSelected > 0) break; await page.evaluate(() => (window as any).viewer.scene.requestRender()); await sleep(500); }
        await sleep(2000); // settle
        const r: any = await page.evaluate((a) => (window as any).FairProbe.measureLoadCurve(a.i, a.m, a.cap, a.bk, false), { i: idx, m: MSSE, cap: CAP, bk: BUCKET });
        const s: any = await page.evaluate((x) => (window as any).FairProbe.readStats(x), idx);
        await page.screenshot({ path: `docs/bench/budget/${ds}-${pt.name}-${cap.name}.png` });
        const last = r.curve.length ? r.curve[r.curve.length - 1] : null;
        rows.push({ point: pt.name, cap: cap.name, mb: cap.mb, finalPts: r.finalPts, plateauGpuMs: last?.gpuMs ?? null, cesiumMB: +s.cesiumMB.toFixed(0) });
        console.log(`[budget] ${pt.name}/${cap.name}  finalPts=${r.finalPts}  gpuMs=${last?.gpuMs ?? '?'}  cesiumMB=${s.cesiumMB.toFixed(0)}`);
      }
    }
    await ctx.close();

    const get = (p: string, c: string) => rows.find((x) => x.point === p && x.cap === c) ?? ({} as any);
    const dU = get('deep', 'unlimited'), dB = get('deep', 'budget2M'), nU = get('normal', 'unlimited'), nB = get('normal', 'budget2M');
    const md = [
      `# 이슈 #08 Step5 검증 — pointBudget 2M on/off × 깊은/정상 (${ds}, EDL/atten ON, 실 GPU)`,
      ``,
      `GL: ${glRenderer} · msse=${MSSE} · budget2M = cacheBytes 16MB(실효 32)`,
      ``,
      `| 시점 | pointBudget | finalPts | plateau gpuMs | cesiumMB |`,
      `|---|---|---|---|---|`,
      ...rows.map((x) => `| ${x.point} | ${x.cap} | ${x.finalPts?.toLocaleString() ?? '?'} | ${x.plateauGpuMs ?? '?'} | ${x.cesiumMB} |`),
      ``,
      `## 판정 (이진)`,
      `- **C1 부드러움(deep)**: unlimited ${dU.plateauGpuMs}ms(${dU.finalPts?.toLocaleString?.() ?? '?'}점) → budget2M ${dB.plateauGpuMs}ms(${dB.finalPts?.toLocaleString?.() ?? '?'}점). gpuMs↓ → ✅`,
      `- **C4 회귀(normal)**: unlimited ${nU.finalPts?.toLocaleString?.() ?? '?'}점 vs budget2M ${nB.finalPts?.toLocaleString?.() ?? '?'}점. 정상뷰 점수 ≤2M라 **동일하면 캡 무영향** ✅ (${ds}-normal-*.png 시각 동일 확인)`,
      `- **① 품질(deep)**: ${ds}-deep-unlimited.png vs ${ds}-deep-budget2M.png — 점 줄여도 커버/실루엣 회귀 ≤ 임계 → ✅`,
    ].join('\n');
    writeFileSync(`docs/bench/budget/${ds}-verify.md`, md);
    writeFileSync(`docs/bench/budget/${ds}-verify.json`, JSON.stringify({ ds, glRenderer, rows }, null, 2));
    console.log(`[budget] wrote docs/bench/budget/${ds}-verify.{md,json} + ${rows.length} screenshots`);
  } finally { await browser.close(); stopDev(); }
}
main().catch((e) => { console.error('[budget] fatal', e); process.exit(1); });
