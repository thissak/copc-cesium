import { chromium, type Browser } from 'playwright';
import { resolve } from 'path';
import { fileURLToPath } from 'url';
import { spawn, type ChildProcess } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import type { BenchConfig, BenchResult, BenchMeta } from './bench/types';
import type { StatSample } from './bench/probe';
import { renderReport } from './bench/report';

// probe-bundle.js is a browser-safe IIFE built from probe.ts via esbuild.
// page.evaluate(importedFn) fails under tsx because esbuild injects __name()
// helpers that don't survive fn.toString() serialization. The bundle approach
// avoids this: inject once via addInitScript, then call via string expressions.
const PROBE_BUNDLE = resolve(fileURLToPath(import.meta.url), '../bench/probe-bundle.js');

interface DatasetDef {
  id: string;
  copcUrl: string;
}
// 검증된 Hobu S3 COPC (CORS·range OK). millsite=깊은 옥트리 perf-wall, sofi=최대.
const DATASETS: Record<string, DatasetDef> = {
  autzen: { id: 'autzen', copcUrl: 'https://s3.amazonaws.com/hobu-lidar/autzen-classified.copc.laz' },
  millsite: { id: 'millsite', copcUrl: 'https://s3.amazonaws.com/hobu-lidar/millsite.copc.laz' },
  sofi: { id: 'sofi', copcUrl: 'https://hobu-lidar.s3.amazonaws.com/sofi.copc.laz' },
};
export const AUTZEN_URL = DATASETS.autzen.copcUrl; // back-compat
function datasetFileRe(copcUrl: string): RegExp {
  return new RegExp(copcUrl.split('/').pop()!.replace(/\./g, '\\.'));
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function pct(arr: number[], p: number): number {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  return +s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))].toFixed(1);
}

export function parseArgs(argv = process.argv.slice(2)): BenchConfig {
  const get = (k: string, d: string) => {
    const i = argv.indexOf(`--${k}`);
    return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
  };
  const target = get('target', 'both');
  if (target !== 'both' && target !== 'ours' && target !== 'eptium') {
    console.error(`[bench] unknown --target: ${target}`);
    process.exit(1);
  }
  const ds = get('ds', 'autzen');
  if (!DATASETS[ds]) {
    console.error(`[bench] unknown --ds: ${ds} (autzen|millsite|sofi)`);
    process.exit(1);
  }
  const msseOurs = get('msse-ours', '');
  const msseEptium = get('msse-eptium', '');
  return {
    ds,
    msse: Number(get('msse', '32')),
    msseOurs: msseOurs ? Number(msseOurs) : undefined,
    msseEptium: msseEptium ? Number(msseEptium) : undefined,
    secs: Number(get('secs', '20')),
    throttle: get('throttle', 'none') as 'none' | 'fast3g',
    settleMs: Number(get('settle', '25000')),
    targets:
      target === 'both' ? ['ours', 'eptium'] : [target as 'ours' | 'eptium'],
  };
}

async function reachable(url: string): Promise<boolean> {
  try {
    const r = await fetch(url);
    return r.status < 500;
  } catch {
    return false;
  }
}

async function ensureDevServer(): Promise<() => void> {
  if (await reachable('http://localhost:5173')) return () => {};
  const child: ChildProcess = spawn('npx', ['vite', '--port', '5173'], {
    cwd: process.cwd(),
    stdio: 'ignore',
  });
  for (let i = 0; i < 60; i++) {
    await sleep(500);
    if (await reachable('http://localhost:5173')) return () => child.kill();
  }
  child.kill();
  throw new Error('dev server failed to start on :5173 (run `npm run dev` 수동)');
}

async function waitForTileset(page: any, timeoutMs: number): Promise<number> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const idx: number = await page.evaluate(() => (window as any).BenchProbe.findTilesetIndex());
    if (idx >= 0) return idx;
    await sleep(500);
  }
  return -1;
}

async function settleFullRes(page: any, idx: number, timeoutMs: number): Promise<number> {
  const start = Date.now();
  let prevReady = -1;
  let stableMs = 0;
  while (Date.now() - start < timeoutMs) {
    const s: StatSample = await page.evaluate(
      (i: number) => (window as any).BenchProbe.readStats(i),
      idx,
    );
    // Settle = no pending requests + content count stable. We deliberately do NOT
    // gate on s.processing (numberOfTilesProcessing): for our SW-backed tileset it
    // stays pinned (~13) forever after the view is complete and never drains, so
    // gating on it never settles → false 25s timeout. Measured via
    // scripts/bench/diag-settle.ts (millsite msse=8): pending→0 & tilesReady→44
    // stabilize at ~14.6s while processing stays stuck at 13. See issue #03.
    // tilesReady is the live signal here (pointsLength stays 0); pointsLength kept as fallback.
    const settled = s.pending === 0 && (s.tilesReady > 0 || s.pointsLength > 0);
    const stableKey = s.tilesReady > 0 ? s.tilesReady : s.pointsLength;
    if (settled && stableKey === prevReady) {
      stableMs += 250;
      if (stableMs >= 3000) break;
    } else {
      stableMs = 0;
      prevReady = stableKey;
    }
    await sleep(250);
  }
  return Date.now() - start - stableMs;
}

export async function measureTarget(
  browser: Browser,
  label: 'ours' | 'eptium',
  url: string,
  cfg: BenchConfig,
): Promise<BenchResult> {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  // Diagnostic listeners — surface console errors and page errors for root-cause analysis
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') {
      console.log(`[${label}-console:${m.type()}]`, m.text());
    }
  });
  page.on('pageerror', (e) => console.log(`[${label}-pageerror]`, e.message));
  const client = await ctx.newCDPSession(page);
  await client.send('Network.enable');
  await client.send('Network.setCacheDisabled', { cacheDisabled: true });
  if (cfg.throttle === 'fast3g') {
    await client.send('Network.emulateNetworkConditions', {
      offline: false,
      latency: 150,
      downloadThroughput: (1.6 * 1024 * 1024) / 8,
      uploadThroughput: (0.75 * 1024 * 1024) / 8,
    });
  }
  const ids = new Set<string>();
  let bytesTotal = 0;
  let reqCount = 0;
  const fileRe = datasetFileRe(DATASETS[cfg.ds].copcUrl);
  client.on('Network.requestWillBeSent', (e: any) => {
    if (fileRe.test(e.request.url)) {
      ids.add(e.requestId);
      reqCount++;
    }
  });
  client.on('Network.loadingFinished', (e: any) => {
    if (ids.has(e.requestId)) bytesTotal += e.encodedDataLength || 0;
  });

  const base: BenchResult = {
    label,
    url,
    ok: false,
    glRenderer: '',
    msse: cfg.msse,
    pointsSelected: 0,
    pointsLength: 0,
    tilesReady: 0,
    tilesTotal: 0,
    bsRadius: 0,
    ttdMs: 0,
    bytesTotal: 0,
    reqCount: 0,
    peakHeapMB: 0,
    frametimeMs: { p50: 0, p95: 0, p99: 0 },
    hitchesGt50: 0,
    longTaskTotalMs: 0,
    fpsFromP50: 0,
  };

  try {
    await page.addInitScript({ path: PROBE_BUNDLE }); // inject probe fns as BenchProbe global, survives SPA navigation
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    const idx = await waitForTileset(page, 45000);
    if (idx < 0) throw new Error(`${label}: tileset not found within 45s`);
    base.glRenderer = await page.evaluate(() => (window as any).BenchProbe.getGlRenderer());
    // 매칭 점수 비교: per-target msse 오버라이드(없으면 공통 msse). 점 개수를 ±10%로 맞춘 operating point.
    const effMsse = label === 'ours' ? cfg.msseOurs ?? cfg.msse : cfg.msseEptium ?? cfg.msse;
    const norm: { radius: number; msse: number } = await page.evaluate(
      (arg: { idx: number; msse: number }) => (window as any).BenchProbe.normalizeAndAnchor(arg),
      { idx, msse: effMsse },
    );
    base.bsRadius = +norm.radius.toFixed(1);
    base.msse = norm.msse;

    // tier 1a: 풀레솔 도달
    base.ttdMs = Math.round(await settleFullRes(page, idx, cfg.settleMs));
    const s: StatSample = await page.evaluate(
      (i: number) => (window as any).BenchProbe.readStats(i),
      idx,
    );
    base.pointsSelected = s.pointsSelected;
    base.pointsLength = s.pointsLength ?? 0;
    base.tilesReady = s.tilesReady;
    base.tilesTotal = s.tilesTotal;
    base.peakHeapMB = s.heapMB;
    base.bytesTotal = bytesTotal;
    base.reqCount = reqCount;

    // tier 1b: 스트레스 경로 중 frametime
    await page.evaluate(() => (window as any).BenchProbe.installProbe());
    await page.evaluate(
      (arg: { idx: number; secs: number }) => (window as any).BenchProbe.runStress(arg),
      { idx, secs: cfg.secs },
    );
    const probe: { frametimes: number[]; longTasks: number[] } = await page.evaluate(() =>
      (window as any).BenchProbe.collectProbe(),
    );
    const ft = probe.frametimes.slice(1); // drop first rAF interval (≈0ms skews p50/p95)
    base.frametimeMs = {
      p50: pct(ft, 50),
      p95: pct(ft, 95),
      p99: pct(ft, 99),
    };
    base.hitchesGt50 = ft.filter((d: number) => d > 50).length;
    base.longTaskTotalMs = probe.longTasks.reduce((a: number, b: number) => a + b, 0);
    base.fpsFromP50 = base.frametimeMs.p50 > 0 ? +(1000 / base.frametimeMs.p50).toFixed(1) : 0;
    const s2: StatSample = await page.evaluate(
      (i: number) => (window as any).BenchProbe.readStats(i),
      idx,
    );
    base.peakHeapMB = Math.max(base.peakHeapMB, s2.heapMB);
    base.ok = true;
  } catch (e) {
    base.error = (e as Error)?.message ?? String(e);
  } finally {
    await ctx.close();
  }
  return base;
}

async function main() {
  const cfg = parseArgs();
  console.log('[bench] config', JSON.stringify(cfg));
  const browser = await chromium.launch({ headless: false });
  const stopDev = cfg.targets.includes('ours') ? await ensureDevServer() : () => {};
  try {
    const results: Record<string, any> = {};
    const dataset = DATASETS[cfg.ds];
    for (const t of cfg.targets) {
      const url =
        t === 'ours'
          ? `http://localhost:5173/?ds=${cfg.ds}`
          : `https://viewer.copc.io/?copc=${dataset.copcUrl}`;
      console.log(`[bench] measuring ${t} (ds=${cfg.ds} msse=${cfg.msse}) …`);
      results[t] = await measureTarget(browser, t, url, cfg);
      const r = results[t];
      console.log(
        `[bench] ${t} ok=${r.ok} pts=${r.pointsSelected} ttd=${r.ttdMs}ms hitch=${r.hitchesGt50} ft95=${r.frametimeMs.p95}ms`,
      );
    }
    const meta: BenchMeta = {
      dataset: cfg.ds,
      datasetUrl: dataset.copcUrl,
      msse: cfg.msse,
      secs: cfg.secs,
      throttle: cfg.throttle,
      timestamp: new Date().toISOString(),
    };
    const ours = results.ours ?? null;
    const eptium = results.eptium ?? null;
    if (ours && eptium) {
      mkdirSync('docs/bench', { recursive: true });
      // 매칭 모드(per-target msse)면 기존 동일-msse 리포트를 덮지 않게 -matched 접미사.
      const tag = cfg.msseOurs !== undefined || cfg.msseEptium !== undefined ? '-matched' : '';
      writeFileSync(`docs/bench/eptium-${cfg.ds}${tag}.md`, renderReport(ours, eptium, meta));
      writeFileSync(
        `docs/bench/eptium-${cfg.ds}${tag}.json`,
        JSON.stringify({ meta, ours, eptium }, null, 2),
      );
      console.log(`[bench] wrote docs/bench/eptium-${cfg.ds}${tag}.{md,json}`);
    } else {
      console.log('[bench] single target — JSON only');
      console.log(JSON.stringify(results, null, 2));
    }
  } finally {
    await browser.close();
    stopDev();
  }
}

main().catch((e) => {
  console.error('[bench] fatal', e);
  process.exit(1);
});
