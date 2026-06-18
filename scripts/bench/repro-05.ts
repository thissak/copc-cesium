// 이슈 #05 재현 — 무거운 로드 메인스레드 longTask/p95 정체 규명.
// CDP CPU 프로파일(메인스레드만 샘플링 → 워커 디코드 제외)로, 로딩 중 메인스레드를 막는 게
// Cesium(pnts 파싱·GPU 업로드) vs 우리 글루 vs GC vs 타일 쇄도 중 무엇인지 self-time 상위로 가른다.
// 사용: dev 서버 먼저 띄우고 `tsx scripts/bench/repro-05.ts [msse=4] [stressSecs=10]`
import { chromium } from 'playwright';
import { resolve } from 'path';
import { fileURLToPath } from 'url';

const PROBE_BUNDLE = resolve(fileURLToPath(import.meta.url), '../probe-bundle.js');
const msse = Number(process.argv[2] || '4');
const stressSecs = Number(process.argv[3] || '10');
const target = (process.argv[4] || 'ours') as 'ours' | 'eptium'; // eptium=viewer.copc.io 같은 방식 프로파일
const extraQuery = process.argv[5] || ''; // ours 전용: 'edl=0&atten=0' (A/B 설정 격리)
const SOFI = 'https://hobu-lidar.s3.amazonaws.com/sofi.copc.laz';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function pct(arr: number[], p: number): number {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  return +s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))].toFixed(1);
}
function shortUrl(u: string): string {
  if (!u) return '(native/runtime)';
  const m = u.match(/[^/]+$/);
  return m ? m[0].split('?')[0] : u;
}
function classify(fn: string, url: string): string {
  if (fn === '(garbage collector)') return 'GC';
  if (fn === '(idle)') return 'idle';
  if (fn === '(program)' || fn === '(root)') return 'runtime';
  const u = (url || '').toLowerCase();
  if (u.includes('cesium')) return 'Cesium';
  if (u.includes('decode.worker')) return 'ours-worker(main에선 거의 없음)';
  if (u.includes('copc') || u.includes('pnts') || u.includes('/src/') || /index-\w+\.js/.test(u) || u.includes('localhost')) return 'ours-main';
  if (!url) return 'native/runtime';
  return `other(${shortUrl(url)})`;
}

async function settle(page: any, idx: number, timeoutMs: number): Promise<{ ms: number; settled: boolean }> {
  let prev = -1, stable = 0;
  const s0 = Date.now();
  while (Date.now() - s0 < timeoutMs) {
    const s: any = await page.evaluate((i: number) => (window as any).BenchProbe.readStats(i), idx);
    const ok = s.pending === 0 && (s.tilesReady > 0 || s.pointsLength > 0);
    const key = s.tilesReady > 0 ? s.tilesReady : s.pointsLength;
    if (ok && key === prev) { stable += 250; if (stable >= 3000) return { ms: Date.now() - s0 - stable, settled: true }; }
    else { stable = 0; prev = key; }
    await sleep(250);
  }
  return { ms: timeoutMs, settled: false };
}

async function main() {
  const browser = await chromium.launch({ headless: false });
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.addInitScript({ path: PROBE_BUNDLE });
  const client = await ctx.newCDPSession(page);
  await client.send('Profiler.enable');
  await client.send('Profiler.setSamplingInterval', { interval: 250 }); // 250us 고해상

  const url = target === 'eptium'
    ? `https://viewer.copc.io/?copc=${SOFI}`
    : `http://localhost:5173/?ds=sofi${extraQuery ? `&${extraQuery}` : ''}`;
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  let idx = -1; const t0 = Date.now();
  while (Date.now() - t0 < 45000) { idx = await page.evaluate(() => (window as any).BenchProbe.findTilesetIndex()); if (idx >= 0) break; await sleep(500); }
  if (idx < 0) throw new Error('tileset not found in 45s');
  await page.evaluate((a: { idx: number; msse: number }) => (window as any).BenchProbe.normalizeAndAnchor(a), { idx, msse });
  await page.evaluate(() => (window as any).BenchProbe.installProbe());

  const churnOnly = process.env.CHURN_ONLY === '1'; // settle 후부터 프로파일 = 초기로딩 제외, 재유도만
  if (!churnOnly) await client.send('Profiler.start'); // 전체(로딩+churn)
  const st = await settle(page, idx, 90000);
  if (churnOnly) await client.send('Profiler.start'); // settle 후 = churn-only(타일 재로드 재유도 격리)
  await page.evaluate((a: { idx: number; secs: number }) => (window as any).BenchProbe.runStress(a), { idx, secs: stressSecs }); // churn longTask 유도
  const stop: any = await client.send('Profiler.stop');
  if (churnOnly) console.log('[모드] churn-only (settle 후 카메라 churn 구간만 — 초기 로딩 셰이더 유도 제외)');
  const profile = stop.profile;
  const probe: any = await page.evaluate(() => (window as any).BenchProbe.collectProbe());
  const stats: any = await page.evaluate((i: number) => (window as any).BenchProbe.readStats(i), idx);

  // --- 분석 ---
  const interval = 0.25; // ms/sample
  const byFn = new Map<string, number>();
  const byClass = new Map<string, number>();
  let totalHits = 0;
  for (const n of profile.nodes) {
    const cf = n.callFrame; const h = n.hitCount || 0; totalHits += h;
    if (!h) continue;
    byFn.set(`${cf.functionName || '(anon)'}  ·  ${shortUrl(cf.url)}`, (byFn.get(`${cf.functionName || '(anon)'}  ·  ${shortUrl(cf.url)}`) || 0) + h);
    const cls = classify(cf.functionName, cf.url);
    byClass.set(cls, (byClass.get(cls) || 0) + h);
  }
  const totalMs = totalHits * interval;
  const lt = probe.longTasks || [];
  const ft = probe.frametimes || [];

  console.log(`\n=== REPRO #05 (sofi msse=${msse}, CDP CPU 프로파일, 실 GPU) ===`);
  console.log(`settle: ${st.settled ? `${st.ms}ms 정착` : `${st.ms}ms 미정착`}  pts=${stats.pointsSelected}  tilesReady=${stats.tilesReady}`);
  console.log(`longTask(>50ms): 수=${lt.length}  합=${lt.reduce((a: number, b: number) => a + b, 0)}ms  max=${Math.max(0, ...lt)}ms`);
  console.log(`frametime: p50=${pct(ft, 50)}ms  p95=${pct(ft, 95)}ms  p99=${pct(ft, 99)}ms  max=${Math.max(0, ...ft).toFixed(0)}ms  (프레임 ${ft.length})`);
  console.log(`프로파일 총 샘플시간: ${totalMs.toFixed(0)}ms (interval 250us)`);

  console.log(`\n--- 메인스레드 self-time 분류 (idle 제외하면 '바쁜 일'의 정체) ---`);
  const idleHits = (byClass.get('idle') || 0) + (byClass.get('runtime') || 0);
  const busyMs = totalMs - idleHits * interval;
  for (const [cls, h] of [...byClass.entries()].sort((a, b) => b[1] - a[1])) {
    const ms = h * interval;
    const busyPct = busyMs > 0 && cls !== 'idle' && cls !== 'runtime' ? `  (바쁜시간의 ${((ms / busyMs) * 100).toFixed(0)}%)` : '';
    console.log(`  ${cls.padEnd(28)} ${ms.toFixed(0).padStart(7)}ms  (전체 ${((ms / totalMs) * 100).toFixed(0)}%)${busyPct}`);
  }
  console.log(`  → 바쁜(non-idle) 메인스레드 시간 합: ${busyMs.toFixed(0)}ms`);

  console.log(`\n--- self-time 상위 함수 TOP 15 (메인스레드 hot spot) ---`);
  const top = [...byFn.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15);
  for (const [fn, h] of top) {
    const ms = h * interval;
    if (ms < 1) continue;
    console.log(`  ${ms.toFixed(0).padStart(6)}ms  ${fn}`);
  }

  // --- 콜패스: 누가 readPixels·셰이더 derivation 을 유발하나 (parent 체인) ---
  const nodeById = new Map<number, any>();
  const parentOf = new Map<number, number>();
  for (const n of profile.nodes) {
    nodeById.set(n.id, n);
    for (const c of n.children || []) parentOf.set(c, n.id);
  }
  function pathOf(targetFn: string): string {
    // 그 함수명을 가진 self-hit 최대 노드 찾기
    let best: any = null;
    for (const n of profile.nodes) {
      if (n.callFrame.functionName === targetFn && (n.hitCount || 0) > (best?.hitCount || 0)) best = n;
    }
    if (!best) return `(${targetFn} 노드 없음)`;
    const chain: string[] = [];
    let id: number | undefined = best.id;
    let guard = 0;
    while (id !== undefined && guard++ < 25) {
      const n = nodeById.get(id);
      if (!n) break;
      chain.push(`${n.callFrame.functionName || '(anon)'}[${shortUrl(n.callFrame.url)}]`);
      id = parentOf.get(id);
    }
    return chain.reverse().join(' → ');
  }
  console.log(`\n--- 콜패스 (유발자 규명) ---`);
  for (const fn of ['readPixels', 'getDerivedShaderProgram', 'createShaderProgram', 'linkProgram', 'compileShader']) {
    const has = profile.nodes.some((n: any) => n.callFrame.functionName === fn);
    if (has) console.log(`[${fn}]\n  ${pathOf(fn)}`);
  }

  await ctx.close();
  await browser.close();
}
main().catch((e) => { console.error('fatal', e); process.exit(1); });
