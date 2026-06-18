// 이슈 #04 재현 — laz-perf WASM 2GB 천장. sofi 를 깊게 로드하며 워커 laz-perf heap 궤적을 측정해
// 2GB abort 메커니즘(단일 거대 노드 vs 누적 성장)을 가린다.
// 사용: dev 서버 먼저 띄우고 `tsx scripts/bench/repro-04.ts [msse=4] [coalesce(0=off)]`
import { chromium } from 'playwright';
import { resolve } from 'path';
import { fileURLToPath } from 'url';

const PROBE_BUNDLE = resolve(fileURLToPath(import.meta.url), '../probe-bundle.js');
const msse = Number(process.argv[2] || '4');
const coalesce = process.argv[3]; // '0' 이면 off
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function settle(page: any, idx: number, timeoutMs: number): Promise<{ ms: number; settled: boolean }> {
  let prev = -1, stable = 0;
  const s0 = Date.now();
  while (Date.now() - s0 < timeoutMs) {
    const s: any = await page.evaluate((i: number) => (window as any).BenchProbe.readStats(i), idx);
    const ok = s.pending === 0 && (s.tilesReady > 0 || s.pointsLength > 0);
    const key = s.tilesReady > 0 ? s.tilesReady : s.pointsLength;
    if (ok && key === prev) {
      stable += 250;
      if (stable >= 3000) return { ms: Date.now() - s0 - stable, settled: true };
    } else { stable = 0; prev = key; }
    await sleep(250);
  }
  return { ms: timeoutMs, settled: false };
}

async function main() {
  const browser = await chromium.launch({ headless: false });
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  let wasmAbort = false, err500 = 0, sliceOverflow = 0;
  let abortMsg = '', firstOverflow = '';
  page.on('console', (m) => {
    const t = m.text();
    if (/Cannot enlarge memory|Aborted\(|enlarge memory/i.test(t)) { wasmAbort = true; if (!abortMsg) abortMsg = t; }
    if (/status of 500/.test(t)) err500++;
    if (/copc#04.*범위초과/.test(t)) { sliceOverflow++; if (!firstOverflow) firstOverflow = t; }
  });
  page.on('pageerror', (e) => { if (/memory|abort/i.test(String(e))) { wasmAbort = true; if (!abortMsg) abortMsg = String(e); } });
  await page.addInitScript({ path: PROBE_BUNDLE });
  const url = `http://localhost:5173/?ds=sofi${coalesce === '0' ? '&coalesce=0' : ''}`;
  await page.goto(url, { waitUntil: 'domcontentloaded' });

  let idx = -1;
  const t0 = Date.now();
  while (Date.now() - t0 < 45000) {
    idx = await page.evaluate(() => (window as any).BenchProbe.findTilesetIndex());
    if (idx >= 0) break;
    await sleep(500);
  }
  if (idx < 0) throw new Error('tileset not found in 45s');
  await page.evaluate((a: { idx: number; msse: number }) => (window as any).BenchProbe.normalizeAndAnchor(a), { idx, msse });

  const st = await settle(page, idx, 90000);
  const stats: any = await page.evaluate((i: number) => (window as any).BenchProbe.readStats(i), idx);
  let prof: any = null;
  try {
    prof = await page.evaluate((i: number) => (window as any).viewer.scene.primitives.get(i).copcProfile(), idx);
  } catch (e) {
    console.log('copcProfile 읽기 실패(워커 abort?):', (e as Error).message);
  }

  console.log(`\n=== REPRO #04 (sofi msse=${msse} coalesce=${coalesce === '0' ? 'OFF' : 'ON'}) ===`);
  console.log(`settle: ${st.settled ? `${st.ms}ms (정착)` : `${st.ms}ms 미정착(타임아웃)`}  pts=${stats.pointsSelected}  tilesReady=${stats.tilesReady}`);
  console.log(`WASM abort 감지: ${wasmAbort ? 'YES ⚠️' : 'no'}   500 에러: ${err500}`);
  console.log(`coalesce 슬라이스 범위초과(#04 근본): ${sliceOverflow}${sliceOverflow ? ' ⚠️' : ''}`);
  if (firstOverflow) console.log(`  첫 범위초과: ${firstOverflow.replace(/^.*copc#04/, 'copc#04').slice(0, 140)}`);
  if (abortMsg) console.log(`  abort msg: ${abortMsg.slice(0, 120)}`);

  if (prof?.decodes?.length) {
    const d = prof.decodes;
    const heaps = d.map((x: any) => x.heapMB);
    const nodePts = d.map((x: any) => x.nodePts);
    const maxNodePts = Math.max(...nodePts);
    const maxNodeDecompMB = (maxNodePts * 30) / 1e6;
    // 단조 성장 여부: 마지막 1/4 평균 vs 첫 1/4 평균
    const q = Math.max(1, Math.floor(d.length / 4));
    const firstQ = heaps.slice(0, q).reduce((a: number, b: number) => a + b, 0) / q;
    const lastQ = heaps.slice(-q).reduce((a: number, b: number) => a + b, 0) / q;
    console.log(`\ndecode 수: ${d.length}`);
    console.log(`laz-perf heap: 시작~${heaps[0]}MB  최대 ${Math.max(...heaps)}MB  끝 ${heaps[heaps.length - 1]}MB`);
    console.log(`  첫 1/4 평균 ${firstQ.toFixed(0)}MB → 끝 1/4 평균 ${lastQ.toFixed(0)}MB  (성장 ${(lastQ - firstQ).toFixed(0)}MB)`);
    console.log(`최대 단일 노드: ${maxNodePts.toLocaleString()}점 → decompressed ${maxNodeDecompMB.toFixed(1)}MB (compressed _malloc 은 더 작음)`);
    // heap 궤적 샘플(10개 구간)
    const step = Math.max(1, Math.floor(d.length / 10));
    const traj = [];
    for (let i = 0; i < d.length; i += step) traj.push(`#${i}:${heaps[i]}MB`);
    console.log(`heap 궤적: ${traj.join('  ')}`);
    // 점프(heap 급증) 디코드 식별 — 직전 대비 +100MB 이상.
    console.log(`\n=== heap 점프 디코드(직전 대비 +100MB↑) ===`);
    let prevH = heaps[0];
    let found = false;
    for (let i = 1; i < d.length; i++) {
      if (heaps[i] - prevH > 100) {
        found = true;
        const x = d[i];
        console.log(`  #${i} key=${x.key}  nodePts=${x.nodePts.toLocaleString()}  kept n=${x.n.toLocaleString()}  decodeMs=${x.decodeMs}  heap ${prevH}→${heaps[i]}MB (+${(heaps[i] - prevH).toFixed(0)})`);
      }
      prevH = heaps[i];
    }
    if (!found) console.log('  (없음 — 점프 디코드가 decodeProfile 에 없거나 push 전 abort)');
    console.log(`\n판정: ${maxNodeDecompMB > 1500 ? '단일 거대 노드' : (lastQ - firstQ > 200 ? '단일 디코드 급증(누적 아님 — 범인 노드 위 참조)' : '미상')}`);
  } else {
    console.log('(decode 프로파일 없음 — 워커가 abort 로 죽어 getProfile 실패했을 수 있음)');
  }

  await ctx.close();
  await browser.close();
}
main().catch((e) => { console.error('fatal', e); process.exit(1); });
