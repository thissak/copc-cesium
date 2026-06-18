// 매칭 점수 scout — ours vs Eptium 의 refine 곡선(msse → pointsSelected)을 떠서
// pointsSelected 가 ±10% 로 겹치는 operating point(msse 쌍)를 찾는다.
// 뷰어당 1회 로드 후 in-page 로 msse 를 바꿔가며 settle·측정(외부 Eptium 로드 최소화).
// 사용: dev 서버 먼저 띄우고 `tsx scripts/bench/match-sweep.ts [ds]`
import { chromium, type Browser } from 'playwright';
import { resolve } from 'path';
import { fileURLToPath } from 'url';

const PROBE_BUNDLE = resolve(fileURLToPath(import.meta.url), '../probe-bundle.js');
const DS: Record<string, string> = {
  autzen: 'https://s3.amazonaws.com/hobu-lidar/autzen-classified.copc.laz',
  millsite: 'https://s3.amazonaws.com/hobu-lidar/millsite.copc.laz',
  sofi: 'https://hobu-lidar.s3.amazonaws.com/sofi.copc.laz',
};
const ds = process.argv[2] || 'millsite';
// argv[3]=target 필터('both'|'ours'|'eptium'), argv[4]=msse 리스트(쉼표). 기본 둘 다·[32,16,8,4,2].
const targetArg = (process.argv[3] || 'both') as 'both' | 'ours' | 'eptium';
const MSSE_LIST = (process.argv[4] ? process.argv[4].split(',').map(Number) : [32, 16, 8, 4, 2]); // 高→低
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function settle(page: any, idx: number, timeoutMs: number): Promise<number> {
  let prev = -1, stable = 0;
  const s0 = Date.now();
  while (Date.now() - s0 < timeoutMs) {
    const s: any = await page.evaluate((i: number) => (window as any).BenchProbe.readStats(i), idx);
    const settled = s.pending === 0 && (s.tilesReady > 0 || s.pointsLength > 0);
    const key = s.tilesReady > 0 ? s.tilesReady : s.pointsLength;
    if (settled && key === prev) {
      stable += 250;
      if (stable >= 3000) return Date.now() - s0 - stable;
    } else { stable = 0; prev = key; }
    await sleep(250);
  }
  return Date.now() - s0; // 미settle(타임아웃)
}

async function sweep(browser: Browser, label: 'ours' | 'eptium', url: string) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.addInitScript({ path: PROBE_BUNDLE });
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  let idx = -1;
  const t0 = Date.now();
  while (Date.now() - t0 < 45000) {
    idx = await page.evaluate(() => (window as any).BenchProbe.findTilesetIndex());
    if (idx >= 0) break;
    await sleep(500);
  }
  if (idx < 0) { console.log(`${label}: tileset 못 찾음`); await ctx.close(); return []; }

  const rows: Array<{ msse: number; pts: number; tiles: number; ttd: number }> = [];
  for (const msse of MSSE_LIST) {
    await page.evaluate(
      (arg: { idx: number; msse: number }) => (window as any).BenchProbe.normalizeAndAnchor(arg),
      { idx, msse },
    );
    const ttd = Math.round(await settle(page, idx, 30000));
    const s: any = await page.evaluate((i: number) => (window as any).BenchProbe.readStats(i), idx);
    rows.push({ msse, pts: s.pointsSelected, tiles: s.tilesReady, ttd });
    console.log(`[${label}] msse=${String(msse).padStart(2)} → pts=${String(s.pointsSelected).padStart(9)}  tiles=${String(s.tilesReady).padStart(4)}  ttd=${ttd}ms`);
  }
  await ctx.close();
  return rows;
}

async function main() {
  console.log(`match-sweep ds=${ds} msse=[${MSSE_LIST.join(',')}]\n`);
  const browser = await chromium.launch({ headless: false });
  try {
    const ours = targetArg !== 'eptium' ? await sweep(browser, 'ours', `http://localhost:5173/?ds=${ds}`) : [];
    const eptium = targetArg !== 'ours' ? await sweep(browser, 'eptium', `https://viewer.copc.io/?copc=${DS[ds]}`) : [];
    console.log('\n=== 매칭 후보 (pointsSelected ±10%) ===');
    for (const o of ours) for (const e of eptium) {
      if (e.pts > 0 && Math.abs(o.pts - e.pts) / e.pts <= 0.1)
        console.log(`  ours msse=${o.msse}(${o.pts}) ≈ eptium msse=${e.msse}(${e.pts})  Δ=${((o.pts - e.pts) / e.pts * 100).toFixed(1)}%`);
    }
  } finally {
    await browser.close();
  }
}
main().catch((e) => { console.error('fatal', e); process.exit(1); });
