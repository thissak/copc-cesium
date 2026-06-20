// scripts/bench/probe-matched.ts — 매칭 예산 head-to-head (이슈 #08 재테스트 마무리)
// fair-compare 가 못 푼 overlap·transient 를 우회: ours 를 Eptium 점 수에 맞춰, 고정 깊은 시점 · 같은 config ·
// 정상상태(plateau=최다프레임 버킷) gpuMs 만 직접 비교. ours=cacheBytes 스윕으로 매칭, Eptium=자체 점예산.
//   ⚠️ 매칭 작동점 한정 — headline 금지(competition-goal-north-star caveat).
//   실행: npm run bench:matched [-- --ds sofi]   (실 GPU headless:false + 외부 viewer.copc.io)
import { chromium, type Browser } from 'playwright';
import { resolve } from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';

const BUNDLE = resolve(fileURLToPath(import.meta.url), '../fair-probe-bundle.js');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const EDL = process.argv.includes('--edl'); // 실사용(EDL/atten on) vs raw 점(off). 직전 매칭 caveat 검증.
const MSSE = 2;        // 깊은 refine 압박 — ours 가 많이 그리려 하고 예산이 캡
const BUCKET = 100_000; // 매칭점 부근(~500-800k) 미세 해상도
const CAP = 60_000;
const OURS_CACHE_MB = [4, 6, 8, 10]; // cacheBytes=overflow=mb(실효 2mb). ~437k~1M 브래킷(Eptium plateau 부근)
const DATASETS: Record<string, string> = {
  millsite: 'https://s3.amazonaws.com/hobu-lidar/millsite.copc.laz',
  sofi: 'https://hobu-lidar.s3.amazonaws.com/sofi.copc.laz',
};

// 한 viewer 의 깊은 시점 plateau 측정 → {finalPts, plateau 버킷(최다 n)의 pts·gpuMs}
async function measure(browser: Browser, url: string, reassert: boolean | 'edlOn', setCacheMb?: number) {
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 900 } });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log('[pageerror]', e.message));
  await page.addInitScript({ path: BUNDLE });
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  let idx = -1;
  for (let i = 0; i < 90 && idx < 0; i++) { await sleep(500); idx = await page.evaluate(() => (window as any).FairProbe.findTilesetIndex()); }
  if (idx < 0) throw new Error(`tileset not found: ${url}`);
  const gl: string = await page.evaluate(() => { const c: any = (window as any).viewer?.canvas; const g: any = c?.getContext('webgl2'); const e = g?.getExtension('WEBGL_debug_renderer_info'); return e ? g.getParameter(e.UNMASKED_RENDERER_WEBGL) : 'unknown'; });
  await page.evaluate((a) => (a.edl ? (window as any).FairProbe.normalizeSurfaceEdlOn(a.i) : (window as any).FairProbe.normalizeConfig(a.i)), { i: idx, edl: EDL });
  if (setCacheMb != null) await page.evaluate((a) => (window as any).FairProbe.setCacheBytes(a.i, a.mb), { i: idx, mb: setCacheMb });
  await page.evaluate((i) => (window as any).FairProbe.setViewpoint(i, 0.15), idx);
  if (!(await page.evaluate((a) => (a.edl ? (window as any).FairProbe.assertSurfaceEdlOn(a.i) : (window as any).FairProbe.assertConfig(a.i)), { i: idx, edl: EDL })))
    throw new Error(`config normalization failed: ${url}`);
  for (let i = 0; i < 60; i++) { const s: any = await page.evaluate((x) => (window as any).FairProbe.readStats(x), idx); if (s.pointsSelected > 0) break; await page.evaluate(() => (window as any).viewer.scene.requestRender()); await sleep(500); }
  await sleep(2000);
  const r: any = await page.evaluate((a) => (window as any).FairProbe.measureLoadCurve(a.i, a.m, a.cap, a.bk, a.r), { i: idx, m: MSSE, cap: CAP, bk: BUCKET, r: reassert });
  await ctx.close();
  // plateau = 최다 프레임(n) 버킷 = 정상상태(로딩 transient 제외)
  const plateau = r.curve.length ? r.curve.reduce((a: any, b: any) => (b.n > a.n ? b : a)) : null;
  return { gl, finalPts: r.finalPts, gpuOk: r.gpuOk, plateauPts: plateau?.pts ?? null, plateauGpuMs: plateau?.gpuMs ?? null, plateauN: plateau?.n ?? 0, curve: r.curve };
}

async function ensureDevServer(): Promise<() => void> {
  const ok = async () => { try { return (await fetch('http://localhost:5173')).status < 500; } catch { return false; } };
  if (await ok()) return () => {};
  const child = spawn('npx', ['vite', '--port', '5173'], { cwd: process.cwd(), stdio: 'ignore' });
  for (let i = 0; i < 60; i++) { await sleep(500); if (await ok()) return () => child.kill(); }
  child.kill(); throw new Error('dev server failed on :5173');
}

async function main() {
  const ds = process.argv.includes('--ds') ? process.argv[process.argv.indexOf('--ds') + 1] : 'sofi';
  if (!DATASETS[ds]) throw new Error(`unknown --ds ${ds}`);
  const browser = await chromium.launch({ headless: false });
  const stopDev = await ensureDevServer();
  mkdirSync('docs/bench/budget', { recursive: true });
  try {
    // 1) Eptium plateau (자체 점예산)
    const eptium = await measure(browser, `https://viewer.copc.io/?copc=${DATASETS[ds]}`, EDL ? 'edlOn' : true);
    console.log(`[matched] eptium  plateauPts=${eptium.plateauPts}  gpuMs=${eptium.plateauGpuMs}  (n=${eptium.plateauN}, finalPts=${eptium.finalPts})`);
    const target = eptium.plateauPts ?? eptium.finalPts;

    // 2) ours cacheBytes 스윕 → plateauPts 가 target 에 가장 가까운 run
    const oursRuns: any[] = [];
    for (const mb of OURS_CACHE_MB) {
      const o = await measure(browser, `http://localhost:5173/?ds=${ds}`, false, mb);
      oursRuns.push({ mb, ...o });
      console.log(`[matched] ours cache=${mb}MB  plateauPts=${o.plateauPts}  gpuMs=${o.plateauGpuMs}  (n=${o.plateauN}, finalPts=${o.finalPts})`);
    }
    const matched = oursRuns.filter((o) => o.plateauPts != null).reduce((a, b) => (Math.abs(b.plateauPts - target) < Math.abs(a.plateauPts - target) ? b : a));

    // 3) 매칭점 비교 (정상상태 gpuMs)
    const mismatch = Math.abs(matched.plateauPts - target) / target;
    const ratio = matched.plateauGpuMs / eptium.plateauGpuMs;
    const fps = (ms: number) => (ms > 0 ? Math.round(1000 / ms) : 0);
    const mode = EDL ? 'EDL/atten ON (실사용)' : 'EDL/atten OFF (raw 점)';
    const md = [
      `# 매칭 예산 head-to-head — ${ds} · ${mode} (깊은 0.15r, 같은 config, 정상상태 plateau, 실 GPU)`,
      ``,
      `GL: ${eptium.gl} · msse=${MSSE} · 셰이딩=${mode} · ⚠️ **매칭 작동점 한정 — headline 금지**`,
      ``,
      `## 매칭점 비교 (plateau = 최다프레임 버킷 = 정상상태)`,
      ``,
      `| 엔진 | plateau 점수 | gpuMs | fps 천장(=1000/gpuMs) |`,
      `|---|---|---|---|`,
      `| ours (cacheBytes ${matched.mb}MB) | ${matched.plateauPts?.toLocaleString()} | ${matched.plateauGpuMs} | ${fps(matched.plateauGpuMs)} |`,
      `| eptium (자체 예산) | ${eptium.plateauPts?.toLocaleString()} | ${eptium.plateauGpuMs} | ${fps(eptium.plateauGpuMs)} |`,
      ``,
      `- 점수 매칭 오차: **${(mismatch * 100).toFixed(1)}%** ${mismatch <= 0.15 ? '✅ (≤15% — 매칭 성립)' : '⚠️ (>15% — 매칭 약함, 해석 주의)'}`,
      `- gpuMs ratio (ours/eptium): **${ratio.toFixed(3)}** → ${Math.abs(ratio - 1) <= 0.15 ? '동급(±15%)' : ratio < 1 ? 'ours 빠름' : 'eptium 빠름'}`,
      ``,
      `## ours cacheBytes 스윕 (매칭점 탐색)`,
      `| cache | plateau 점수 | gpuMs | n |`,
      `|---|---|---|---|`,
      ...oursRuns.map((o) => `| ${o.mb}MB | ${o.plateauPts?.toLocaleString() ?? '?'} | ${o.plateauGpuMs ?? '?'} | ${o.plateauN} |`),
      ``,
      `> 정직성: 매칭점 한정 결과. 셰이딩=${mode}, globe off·res=1. gpuMs=GPU 타이머(vsync 무관).`,
      `> 한계: viewpoint=각 bs×0.15(ECEF 중심 동일, 반경 차이 가능). Eptium plateau 는 뷰포트 의존(회차 변동). EDL on 시 양 엔진 각자 네이티브 셰이딩(파라미터 미정합).`,
    ].join('\n');
    const suffix = EDL ? '-edl' : '';
    writeFileSync(`docs/bench/budget/matched-${ds}${suffix}.md`, md);
    writeFileSync(`docs/bench/budget/matched-${ds}${suffix}.json`, JSON.stringify({ ds, msse: MSSE, edl: EDL, target, eptium, oursRuns, matched, mismatch, ratio }, null, 2));
    console.log(`[matched] wrote docs/bench/budget/matched-${ds}${suffix}.{md,json}  ratio=${ratio.toFixed(3)} mismatch=${(mismatch * 100).toFixed(1)}%`);
  } finally { await browser.close(); stopDev(); }
}
main().catch((e) => { console.error('[matched] fatal', e); process.exit(1); });
