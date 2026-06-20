// scripts/bench/probe-budget.ts — 이슈 #08 전수 검증 (기본 pointBudget=2M 회귀 검증)
// dual review BLOCKING: 기본 2M 캡이 정상 뷰 동작을 바꾸나? → msse=8(실사용 기본)에서 데이터셋 전수 측정.
// 핵심 논리: 캡은 "뷰가 예산을 초과할 때만" 작동 → msse=8 정상 뷰 무제한 점수 < 2M 이면 캡 수학적으로 안 걸림(회귀 0).
//   매트릭스: {autzen·millsite·sofi} × {normal 1.0r · deep 0.15r} × {off(무제한) · budget2M}
//   cold-start(리로드) · EDL/atten ON 실사용 · res=1 · 로드 시작 대기(0점 측정오염 방지, 실패 시 throw).
//   실효 메모리 한도 = cacheBytes + maximumCacheOverflowBytes = 2×mb (16MB ≈ pointBudget 2M; 점당 실측 ~16B).
//   실행: npm run bench:budget [-- --msse 8 --ds autzen,millsite,sofi]   (실 GPU headless:false)
import { chromium } from 'playwright';
import { resolve } from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';

const BUNDLE = resolve(fileURLToPath(import.meta.url), '../fair-probe-bundle.js');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const arg = (k: string) => (process.argv.includes(k) ? process.argv[process.argv.indexOf(k) + 1] : undefined);
const MSSE = Number(arg('--msse')) || 8; // 8=실사용 기본(회귀 검증). 2=공격적(캡 효과 가시화).
const DS_LIST = (arg('--ds') ?? 'autzen,millsite,sofi').split(',').map((s) => s.trim());
const BUCKET = 250_000;
const CAP = 60_000; // plateau 측정 상한(5s 정지 조기종료 내장)
const POINTS = [
  { name: 'normal', factor: 1.0 },  // 회귀 핵심 — 무제한 점수<2M 면 캡 무영향
  { name: 'deep', factor: 0.15 },   // 캡 이득 측정
];
const CAPS = [
  { name: 'off', mb: 512 },       // pointBudget off (Cesium 기본 무제한)
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
    for (const ds of DS_LIST) {
      for (const pt of POINTS) {
        for (const cap of CAPS) {
          await page.goto(`http://localhost:5173/?ds=${ds}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
          let idx = -1;
          for (let i = 0; i < 90 && idx < 0; i++) { await sleep(500); idx = await page.evaluate(() => (window as any).FairProbe.findTilesetIndex()); }
          if (idx < 0) throw new Error(`${ds}/${pt.name}/${cap.name}: tileset not found within 45s`);
          if (glRenderer === 'unknown')
            glRenderer = await page.evaluate(() => { const c: any = (window as any).viewer?.canvas; const gl: any = c?.getContext('webgl2'); const e = gl?.getExtension('WEBGL_debug_renderer_info'); return e ? gl.getParameter(e.UNMASKED_RENDERER_WEBGL) : 'unknown'; });
          await page.evaluate(() => { const v: any = (window as any).viewer; if (v.scene.globe) v.scene.globe.show = false; v.imageryLayers?.removeAll?.(); v.useBrowserRecommendedResolution = false; v.resolutionScale = 1; });
          await page.evaluate((a) => { (window as any).FairProbe.setMsse(a.i, a.m); (window as any).FairProbe.setCacheBytes(a.i, a.mb); }, { i: idx, m: MSSE, mb: cap.mb });
          await page.evaluate((a) => (window as any).FairProbe.setViewpoint(a.i, a.f), { i: idx, f: pt.factor });
          // 로드 시작 대기(0점 측정오염 방지). 30s 내 미시작이면 측정 무효 → throw(리뷰: fall-through 금지).
          let started = false;
          for (let i = 0; i < 60; i++) { const s: any = await page.evaluate((x) => (window as any).FairProbe.readStats(x), idx); if (s.pointsSelected > 0) { started = true; break; } await page.evaluate(() => (window as any).viewer.scene.requestRender()); await sleep(500); }
          if (!started) throw new Error(`${ds}/${pt.name}/${cap.name}: 30s 내 점 로드 시작 안 됨 (측정 무효)`);
          await sleep(2000); // settle
          const r: any = await page.evaluate((a) => (window as any).FairProbe.measureLoadCurve(a.i, a.m, a.cap, a.bk, false), { i: idx, m: MSSE, cap: CAP, bk: BUCKET });
          const s: any = await page.evaluate((x) => (window as any).FairProbe.readStats(x), idx);
          await page.screenshot({ path: `docs/bench/budget/${ds}-m${MSSE}-${pt.name}-${cap.name}.png` });
          const last = r.curve.length ? r.curve[r.curve.length - 1] : null;
          rows.push({ ds, point: pt.name, cap: cap.name, finalPts: r.finalPts, plateauGpuMs: last?.gpuMs ?? null, cesiumMB: +s.cesiumMB.toFixed(0) });
          console.log(`[budget] ${ds}/${pt.name}/${cap.name}  finalPts=${r.finalPts}  gpuMs=${last?.gpuMs ?? '?'}  cesiumMB=${s.cesiumMB.toFixed(0)}`);
        }
      }
    }
    await ctx.close();

    // 동적 판정(리뷰: 하드코딩 가정 금지) — 측정값으로 회귀/이득 산정.
    const BUDGET = 2_000_000;
    const TOL = 0.05; // off vs 2M 동등 허용(노이즈)
    const get = (ds: string, p: string, c: string) => rows.find((x) => x.ds === ds && x.point === p && x.cap === c) ?? ({} as any);
    const verdicts: string[] = [];
    for (const ds of DS_LIST) {
      const nOff = get(ds, 'normal', 'off'), nCap = get(ds, 'normal', 'budget2M');
      const dOff = get(ds, 'deep', 'off'), dCap = get(ds, 'deep', 'budget2M');
      // 회귀: 정상 뷰 무제한 점수가 예산 미만이면 캡 무영향 → off≈cap. 예산 초과면 캡이 점수 깎음(동작 변경).
      const nNoBite = nOff.finalPts != null && nOff.finalPts <= BUDGET * (1 + TOL);
      const nEqual = nOff.finalPts != null && nCap.finalPts != null && Math.abs(nCap.finalPts - nOff.finalPts) / nOff.finalPts <= TOL;
      const reg = nNoBite
        ? `회귀 0 ✅ (정상뷰 무제한 ${nOff.finalPts?.toLocaleString?.()}점 ≤ 2M → 캡 미작동)`
        : nEqual
          ? `회귀 0 ✅ (정상뷰 off ${nOff.finalPts?.toLocaleString?.()} ≈ cap ${nCap.finalPts?.toLocaleString?.()})`
          : `⚠️ 회귀 위험: 정상뷰 off ${nOff.finalPts?.toLocaleString?.()} → cap ${nCap.finalPts?.toLocaleString?.()} (캡이 정상뷰 점수 깎음)`;
      const benefit = dOff.finalPts != null && dCap.finalPts != null && dOff.plateauGpuMs != null && dCap.plateauGpuMs != null
        ? `이득: 깊은뷰 ${dOff.finalPts?.toLocaleString?.()}점/${dOff.plateauGpuMs}ms → ${dCap.finalPts?.toLocaleString?.()}점/${dCap.plateauGpuMs}ms`
        : `이득: 측정 불가`;
      verdicts.push(`- **${ds}**: ${reg} · ${benefit}`);
    }

    const md = [
      `# 이슈 #08 전수 검증 — 기본 pointBudget=2M 회귀 (msse=${MSSE} 실사용, EDL/atten ON, 실 GPU)`,
      ``,
      `GL: ${glRenderer} · budget2M = cacheBytes 16MB(실효 32) · 데이터셋 ${DS_LIST.join('·')}`,
      ``,
      `| 데이터셋 | 시점 | pointBudget | finalPts | plateau gpuMs | cesiumMB |`,
      `|---|---|---|---|---|---|`,
      ...rows.map((x) => `| ${x.ds} | ${x.point} | ${x.cap} | ${x.finalPts?.toLocaleString() ?? '?'} | ${x.plateauGpuMs ?? '?'} | ${x.cesiumMB} |`),
      ``,
      `## 판정 (동적, 측정값 기반)`,
      ...verdicts,
      ``,
      `> 회귀 기준: 정상 뷰(1.0r) 무제한 점수 ≤ 2M(±5%) 또는 off≈cap → 기본 캡이 정상뷰 미작동(동작 불변). msse=${MSSE}는 실사용 기본.`,
    ].join('\n');
    writeFileSync(`docs/bench/budget/regression-m${MSSE}.md`, md);
    writeFileSync(`docs/bench/budget/regression-m${MSSE}.json`, JSON.stringify({ msse: MSSE, glRenderer, rows }, null, 2));
    console.log(`[budget] wrote docs/bench/budget/regression-m${MSSE}.{md,json} + ${rows.length} screenshots`);
  } finally { await browser.close(); stopDev(); }
}
main().catch((e) => { console.error('[budget] fatal', e); process.exit(1); });
