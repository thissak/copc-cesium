# Eptium 오라클 벤치 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** autzen 데이터셋에서 우리 `CopcTileset` vs Eptium(`viewer.copc.io`)을 같은 데이터·뷰포인트·msse로 측정해, 매 최적화 후 재실행하는 북극성 비교표(`docs/bench/eptium-autzen.md`)를 생성한다.

**Architecture:** 둘 다 CesiumJS이고 `window.viewer`(우리=main.ts:36, Eptium=PoC 확인) + `Cesium3DTileset`(`.statistics`/`.maximumScreenSpaceError`) + Cesium `Camera`를 노출한다. 따라서 한 Playwright(headed, 실 GPU) 하니스가 **양쪽을 동일 코드로 대칭 구동**한다: 페이지에 측정 프로브를 주입하고, `flyToBoundingSphere(duration:0)`로 고정뷰 앵커 후 `zoomIn/zoomOut/rotateRight`로 대칭 스트레스. 네트워크 바이트는 CDP(`Network.loadingFinished.encodedDataLength`)로만 잰다(cross-origin S3라 Resource Timing은 0).

**Tech Stack:** Playwright(Chromium headed) + CDP, TypeScript(tsx 실행), 기존 Vite dev 서버(우리 앱 호스팅). 측정 신호는 양쪽 공통 `Cesium3DTileset.statistics`.

## Global Constraints

- TypeScript strict. 기존 파일 스타일(`scripts/verify.ts` assertion 관용구)을 따른다. 이 프로젝트엔 단위테스트 프레임워크가 없으므로 순수 로직 테스트는 **tsx assertion 스크립트**로 작성한다.
- 측정 신뢰모델 = **2-tier**: 1급(재현·자동) = TTD·bytes·req수·peakHeap(+1b frametime/hitch), 2급(실GPU 수동성격) = fps. **헤드리스 swiftshader fps는 표에 올리지 않는다**; 이 하니스는 headed=실GPU라 fps는 2급으로 보조 기재하되 `glRenderer` 증거를 함께 남긴다.
- **품질 정규화 필수**: 양쪽 `maximumScreenSpaceError`를 동일값(기본 32, Eptium 관측 기본값)으로 강제하고 `numberOfPointsSelected`를 양쪽에서 읽어 동일 품질을 증명한다.
- **조용한 실패 금지**([[no-silent-failures]]): Eptium/우리 타일셋 로드 실패·타임아웃은 throw하고 리포트에 명시한다. 부분표를 "성공"처럼 내지 않는다.
- 데이터셋 = autzen 고정: `https://s3.amazonaws.com/hobu-lidar/autzen-classified.copc.laz` (Hobu S3, 양쪽 CORS·range 보장).
- 대용량 COPC·스크린샷 바이너리를 repo에 커밋하지 않는다. 산출물은 텍스트(`.md`/`.json`)만.

**확정된 전제(코드/PoC 확인 완료, 재작업 불필요):**
- 우리 `window.viewer` 노출됨 — `src/main.ts:36`.
- 우리 기본 라우트 `?ds=autzen` → `CopcTileset.fromUrl` 스트리밍, `scene.primitives.add` — `src/main.ts:860-876`.
- Eptium `window.viewer` 노출 + `scene.primitives.get(1)`=Cesium3DTileset(`.statistics.numberOfPointsSelected`, `.maximumScreenSpaceError=32`), camera `{setView,lookAt,flyTo,flyToBoundingSphere}` — PoC 2026-06-18.

---

### Task 1: 하니스 스캐폴드 (의존성·CLI·타입)

**Files:**
- Modify: `package.json` (devDependencies + scripts)
- Create: `scripts/bench/types.ts`
- Create: `scripts/compare-eptium.ts` (CLI 골격)

**Interfaces:**
- Produces: `BenchResult`, `BenchMeta` 타입; `parseArgs(): BenchConfig`; npm 스크립트 `bench:eptium`.

- [ ] **Step 1: `playwright` 설치 + 스크립트 추가**

`package.json`의 `devDependencies`에 `"playwright": "^1.48.0"` 추가, `scripts`에 추가:
```json
"bench:eptium": "tsx scripts/compare-eptium.ts"
```
그 후:
```bash
npm install
npx playwright install chromium
```

- [ ] **Step 2: 결과 타입 작성**

`scripts/bench/types.ts`:
```ts
export interface BenchResult {
  label: string; // 'ours' | 'eptium'
  url: string;
  ok: boolean;
  error?: string;
  glRenderer: string; // 실GPU vs swiftshader 증거
  // 정규화 증인
  msse: number;
  pointsSelected: number;
  tilesReady: number;
  tilesTotal: number;
  bsRadius: number;
  // tier 1a (북극성)
  ttdMs: number;
  bytesTotal: number;
  reqCount: number;
  peakHeapMB: number;
  // tier 1b (보조)
  frametimeMs: { p50: number; p95: number; p99: number };
  hitchesGt50: number;
  longTaskTotalMs: number;
  // tier 2 (실GPU 보조)
  fpsFromP50: number;
}

export interface BenchMeta {
  dataset: string;
  datasetUrl: string;
  msse: number;
  secs: number;
  throttle: string;
  timestamp: string;
}

export interface BenchConfig {
  msse: number;
  secs: number;
  throttle: 'none' | 'fast3g';
  targets: Array<'ours' | 'eptium'>;
}
```

- [ ] **Step 3: CLI 골격 작성**

`scripts/compare-eptium.ts`:
```ts
import type { BenchConfig } from './bench/types';

export const AUTZEN_URL =
  'https://s3.amazonaws.com/hobu-lidar/autzen-classified.copc.laz';

export function parseArgs(argv = process.argv.slice(2)): BenchConfig {
  const get = (k: string, d: string) => {
    const i = argv.indexOf(`--${k}`);
    return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
  };
  const target = get('target', 'both');
  return {
    msse: Number(get('msse', '32')),
    secs: Number(get('secs', '20')),
    throttle: get('throttle', 'none') as 'none' | 'fast3g',
    targets:
      target === 'both' ? ['ours', 'eptium'] : [target as 'ours' | 'eptium'],
  };
}

async function main() {
  const cfg = parseArgs();
  console.log('[bench] config', JSON.stringify(cfg));
  // Task 5에서 측정/리포트 채움
}

main().catch((e) => {
  console.error('[bench] fatal', e);
  process.exit(1);
});
```

- [ ] **Step 4: 골격 실행 검증**

Run: `npx tsx scripts/compare-eptium.ts --msse 8 --target eptium`
Expected: `[bench] config {"msse":8,"secs":20,"throttle":"none","targets":["eptium"]}` 출력 후 정상 종료.

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json scripts/bench/types.ts scripts/compare-eptium.ts
git commit -m "feat(bench): Eptium 비교 하니스 스캐폴드 — playwright devDep + CLI/타입"
```

---

### Task 2: 페이지 주입 프로브 (대칭 구동)

**Files:**
- Create: `scripts/bench/probe.ts`

**Interfaces:**
- Produces: 페이지 컨텍스트에서 실행될 의존성 없는 함수들 — `findTilesetIndex(): number`, `normalizeAndAnchor(arg:{idx:number;msse:number}): {radius:number;msse:number}`, `readStats(idx:number): StatSample`, `installProbe(): void`, `runStress(arg:{idx:number;secs:number}): Promise<void>`, `collectProbe(): {frametimes:number[];longTasks:number[]}`, `getGlRenderer(): string`. 모두 `window.viewer`만 의존(외부 스코프·import 참조 금지 — `page.evaluate`로 직렬화됨).

- [ ] **Step 1: 프로브 모듈 작성**

`scripts/bench/probe.ts`:
```ts
// 모든 함수는 page.evaluate 로 직렬화되어 브라우저에서 실행된다.
// 외부 스코프/임포트를 참조하면 안 된다. window.viewer 만 의존.

export interface StatSample {
  pointsSelected: number;
  tilesReady: number;
  tilesTotal: number;
  pending: number;
  processing: number;
  heapMB: number;
}

export function findTilesetIndex(): number {
  const v: any = (window as any).viewer;
  if (!v || !v.scene || !v.scene.primitives) return -1;
  const prims = v.scene.primitives;
  for (let i = 0; i < prims.length; i++) {
    let p: any;
    try {
      p = prims.get(i);
    } catch {
      continue;
    }
    if (p && p.statistics && typeof p.maximumScreenSpaceError === 'number') return i;
  }
  return -1;
}

export function normalizeAndAnchor(arg: { idx: number; msse: number }): {
  radius: number;
  msse: number;
} {
  const v: any = (window as any).viewer;
  if (v.scene.globe) v.scene.globe.show = false;
  if (v.imageryLayers && v.imageryLayers.removeAll) v.imageryLayers.removeAll();
  const ts: any = v.scene.primitives.get(arg.idx);
  ts.maximumScreenSpaceError = arg.msse;
  const bs = ts.boundingSphere;
  v.camera.flyToBoundingSphere(bs, { duration: 0 });
  v.scene.requestRender();
  return { radius: bs.radius, msse: ts.maximumScreenSpaceError };
}

export function readStats(idx: number): StatSample {
  const v: any = (window as any).viewer;
  const ts: any = v.scene.primitives.get(idx);
  const st: any = ts.statistics || {};
  const mem: any = (performance as any).memory;
  return {
    pointsSelected: st.numberOfPointsSelected ?? 0,
    tilesReady: st.numberOfTilesWithContentReady ?? 0,
    tilesTotal: st.numberOfTilesTotal ?? 0,
    pending: st.numberOfPendingRequests ?? 0,
    processing: st.numberOfTilesProcessing ?? 0,
    heapMB: mem ? +(mem.usedJSHeapSize / 1048576).toFixed(1) : 0,
  };
}

export function installProbe(): void {
  const w: any = window;
  w.__bench = { frametimes: [], longTasks: [], last: performance.now(), collecting: true };
  const v: any = w.viewer;
  const loop = () => {
    const now = performance.now();
    w.__bench.frametimes.push(now - w.__bench.last);
    w.__bench.last = now;
    if (v && v.scene && v.scene.requestRender) v.scene.requestRender();
    if (w.__bench.collecting) requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
  try {
    const obs = new PerformanceObserver((l) => {
      for (const e of l.getEntries()) w.__bench.longTasks.push(Math.round((e as any).duration));
    });
    obs.observe({ type: 'longtask' } as any);
    w.__bench.obs = obs;
  } catch {
    /* longtask 미지원 → 빈 배열 */
  }
}

export async function runStress(arg: { idx: number; secs: number }): Promise<void> {
  const v: any = (window as any).viewer;
  const ts: any = v.scene.primitives.get(arg.idx);
  const bs = ts.boundingSphere;
  const cam = v.camera;
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const start = performance.now();
  const dur = arg.secs * 1000;
  while (performance.now() - start < dur) {
    cam.flyToBoundingSphere(bs, { duration: 0 }); // 결정적 재앵커
    cam.zoomIn(bs.radius * 0.7); // 깊은 LOD 다이브
    v.scene.requestRender();
    await sleep(700);
    cam.rotateRight(0.6); // 새 섹터로 팬
    v.scene.requestRender();
    await sleep(500);
    cam.zoomOut(bs.radius * 0.5); // 후퇴 → unload churn
    v.scene.requestRender();
    await sleep(500);
  }
}

export function collectProbe(): { frametimes: number[]; longTasks: number[] } {
  const w: any = window;
  w.__bench.collecting = false;
  if (w.__bench.obs)
    try {
      w.__bench.obs.disconnect();
    } catch {
      /* noop */
    }
  return { frametimes: w.__bench.frametimes, longTasks: w.__bench.longTasks };
}

export function getGlRenderer(): string {
  try {
    const c: any = document.querySelector('canvas');
    const gl: any = c && (c.getContext('webgl2') || c.getContext('webgl'));
    if (!gl) return 'no-webgl';
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    return ext
      ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL))
      : String(gl.getParameter(gl.RENDERER));
  } catch {
    return 'err';
  }
}
```

- [ ] **Step 2: 타입체크 검증**

Run: `npx tsc --noEmit`
Expected: 에러 없음 (exit 0).

- [ ] **Step 3: Commit**

```bash
git add scripts/bench/probe.ts
git commit -m "feat(bench): 페이지 주입 프로브 — 대칭 구동(find/normalize/stats/stress/probe)"
```

---

### Task 3: 단일 타깃 측정 드라이버 (1a + 1b)

**Files:**
- Modify: `scripts/compare-eptium.ts`

**Interfaces:**
- Consumes: `probe.ts`의 모든 함수, `BenchResult`.
- Produces: `measureTarget(browser, label, url, cfg): Promise<BenchResult>`, `waitForTileset`, `settleFullRes`, `pct`.

- [ ] **Step 1: 측정 드라이버 작성**

`scripts/compare-eptium.ts` 상단 import 교체 + 함수 추가:
```ts
import { chromium, type Browser } from 'playwright';
import type { BenchConfig, BenchResult } from './bench/types';
import {
  findTilesetIndex,
  normalizeAndAnchor,
  readStats,
  installProbe,
  runStress,
  collectProbe,
  getGlRenderer,
} from './bench/probe';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function pct(arr: number[], p: number): number {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  return +s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))].toFixed(1);
}

async function waitForTileset(page: any, timeoutMs: number): Promise<number> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const idx = await page.evaluate(findTilesetIndex);
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
    const s = await page.evaluate(readStats, idx);
    if (s.pending === 0 && s.processing === 0 && s.tilesReady > 0 && s.tilesReady === prevReady) {
      stableMs += 250;
      if (stableMs >= 1250) break;
    } else {
      stableMs = 0;
      prevReady = s.tilesReady;
    }
    await sleep(250);
  }
  return Date.now() - start - stableMs;
}

export async function measureTarget(
  browser: Browser,
  label: string,
  url: string,
  cfg: BenchConfig,
): Promise<BenchResult> {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
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
  const reAutzen = /autzen-classified\.copc\.laz/;
  client.on('Network.requestWillBeSent', (e: any) => {
    if (reAutzen.test(e.request.url)) {
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
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    base.glRenderer = await page.evaluate(getGlRenderer);
    const idx = await waitForTileset(page, 45000);
    if (idx < 0) throw new Error(`${label}: tileset not found within 45s`);
    const norm = await page.evaluate(normalizeAndAnchor, { idx, msse: cfg.msse });
    base.bsRadius = +norm.radius.toFixed(1);
    base.msse = norm.msse;

    // tier 1a: 풀레솔 도달
    base.ttdMs = Math.round(await settleFullRes(page, idx, 25000));
    const s = await page.evaluate(readStats, idx);
    base.pointsSelected = s.pointsSelected;
    base.tilesReady = s.tilesReady;
    base.tilesTotal = s.tilesTotal;
    base.peakHeapMB = s.heapMB;
    base.bytesTotal = bytesTotal;
    base.reqCount = reqCount;

    // tier 1b: 스트레스 경로 중 frametime
    await page.evaluate(installProbe);
    await page.evaluate(runStress, { idx, secs: cfg.secs });
    const probe = await page.evaluate(collectProbe);
    base.frametimeMs = {
      p50: pct(probe.frametimes, 50),
      p95: pct(probe.frametimes, 95),
      p99: pct(probe.frametimes, 99),
    };
    base.hitchesGt50 = probe.frametimes.filter((d: number) => d > 50).length;
    base.longTaskTotalMs = probe.longTasks.reduce((a: number, b: number) => a + b, 0);
    base.fpsFromP50 = base.frametimeMs.p50 > 0 ? +(1000 / base.frametimeMs.p50).toFixed(1) : 0;
    const s2 = await page.evaluate(readStats, idx);
    base.peakHeapMB = Math.max(base.peakHeapMB, s2.heapMB);
    base.ok = true;
  } catch (e) {
    base.error = (e as Error)?.message ?? String(e);
  } finally {
    await ctx.close();
  }
  return base;
}
```

- [ ] **Step 2: main()에서 Eptium 단독 측정 임시 배선**

`main()`을 다음으로 교체(검증용; Task 5에서 양쪽+리포트로 확장):
```ts
async function main() {
  const cfg = parseArgs();
  console.log('[bench] config', JSON.stringify(cfg));
  const browser = await chromium.launch({ headless: false });
  try {
    const eptium = await measureTarget(
      browser,
      'eptium',
      `https://viewer.copc.io/?copc=${AUTZEN_URL}`,
      cfg,
    );
    console.log('[bench] eptium', JSON.stringify(eptium, null, 2));
  } finally {
    await browser.close();
  }
}
```

- [ ] **Step 3: Eptium 단독 측정 실행 검증**

Run: `npx tsx scripts/compare-eptium.ts --target eptium --msse 32 --secs 12`
Expected: headed Chromium이 뜨고 autzen 렌더 후, `eptium` JSON에서 `ok:true`, `pointsSelected > 0`(약 50만대), `ttdMs > 0`, `bytesTotal > 0`, `reqCount > 0`, `glRenderer`에 GPU 문자열. (값은 환경마다 다름 — 0이 아니고 ok:true 이면 통과.)

- [ ] **Step 4: Commit**

```bash
git add scripts/compare-eptium.ts
git commit -m "feat(bench): 단일 타깃 측정 드라이버 — 1a(TTD/bytes/heap)+1b(frametime/hitch), CDP 바이트"
```

---

### Task 4: 리포트 렌더러 (순수) + selftest

**Files:**
- Create: `scripts/bench/report.ts`
- Create: `scripts/bench/selftest.ts`

**Interfaces:**
- Consumes: `BenchResult`, `BenchMeta`.
- Produces: `pctDelta(ours:number, base:number): string`, `renderReport(ours:BenchResult, eptium:BenchResult, meta:BenchMeta): string`.

- [ ] **Step 1: 실패하는 selftest 먼저 작성**

`scripts/bench/selftest.ts`:
```ts
import { pctDelta, renderReport } from './report';
import type { BenchResult, BenchMeta } from './types';

function assert(cond: boolean, msg: string) {
  if (!cond) {
    console.error('FAIL: ' + msg);
    process.exit(1);
  }
  console.log('ok: ' + msg);
}

assert(pctDelta(80, 100) === '-20%', 'pctDelta 80/100 = -20%');
assert(pctDelta(120, 100) === '+20%', 'pctDelta 120/100 = +20%');
assert(pctDelta(5, 0) === 'n/a', 'pctDelta zero base = n/a');

const mk = (label: string, over: Partial<BenchResult>): BenchResult => ({
  label,
  url: 'u',
  ok: true,
  glRenderer: 'Apple M4 Pro',
  msse: 32,
  pointsSelected: 577000,
  tilesReady: 17,
  tilesTotal: 280,
  bsRadius: 881,
  ttdMs: 1000,
  bytesTotal: 18_000_000,
  reqCount: 22,
  peakHeapMB: 120,
  frametimeMs: { p50: 16, p95: 22, p99: 40 },
  hitchesGt50: 1,
  longTaskTotalMs: 80,
  fpsFromP50: 62,
  ...over,
});

const meta: BenchMeta = {
  dataset: 'autzen',
  datasetUrl: 'https://s3.amazonaws.com/hobu-lidar/autzen-classified.copc.laz',
  msse: 32,
  secs: 20,
  throttle: 'none',
  timestamp: '2026-06-18T00:00:00.000Z',
};

const md = renderReport(mk('ours', { ttdMs: 800 }), mk('eptium', { ttdMs: 1000 }), meta);
assert(md.includes('TTD'), 'report has TTD row');
assert(md.includes('ours') && md.includes('eptium'), 'report has both columns');
assert(/msse/i.test(md) && md.includes('autzen'), 'report has conditions (msse + dataset)');
assert(md.includes('577'), 'report shows pointsSelected witness');
console.log('selftest passed');
```

- [ ] **Step 2: selftest 실패 확인**

Run: `npx tsx scripts/bench/selftest.ts`
Expected: FAIL — `Cannot find module './report'` (또는 export 없음).

- [ ] **Step 3: 리포트 렌더러 구현**

`scripts/bench/report.ts`:
```ts
import type { BenchResult, BenchMeta } from './types';

export function pctDelta(ours: number, base: number): string {
  if (!base) return 'n/a';
  const d = ((ours - base) / base) * 100;
  return (d >= 0 ? '+' : '') + d.toFixed(0) + '%';
}

export function renderReport(ours: BenchResult, eptium: BenchResult, meta: BenchMeta): string {
  const row = (
    name: string,
    pick: (r: BenchResult) => number,
    fmt: (n: number) => string = (n) => String(n),
  ) => `| ${name} | ${fmt(pick(ours))} | ${fmt(pick(eptium))} | ${pctDelta(pick(ours), pick(eptium))} |`;

  const mb = (n: number) => (n / 1048576).toFixed(1) + ' MB';
  const ms = (n: number) => n.toFixed(0) + ' ms';

  const lines: string[] = [];
  lines.push(`# Eptium 오라클 벤치 — ${meta.dataset}`);
  lines.push('');
  lines.push(
    `> 측정 ${meta.timestamp} · 데이터 \`${meta.dataset}\` · **msse=${meta.msse}** · 스트레스 ${meta.secs}s · 네트워크 ${meta.throttle}`,
  );
  lines.push(
    `> 우리 GL: \`${ours.glRenderer}\` · Eptium GL: \`${eptium.glRenderer}\``,
  );
  lines.push('');
  lines.push('## 품질 정규화 증인 (이게 안 맞으면 아래 비교 무효)');
  lines.push('');
  lines.push('| 증인 | ours | eptium |');
  lines.push('|------|------|--------|');
  lines.push(`| msse | ${ours.msse} | ${eptium.msse} |`);
  lines.push(`| numberOfPointsSelected | ${ours.pointsSelected.toLocaleString()} | ${eptium.pointsSelected.toLocaleString()} |`);
  lines.push(`| tilesReady / total | ${ours.tilesReady}/${ours.tilesTotal} | ${eptium.tilesReady}/${eptium.tilesTotal} |`);
  lines.push('');
  lines.push('## Tier 1a — 북극성 (재현·자동, 낮을수록 좋음 ↓)');
  lines.push('');
  lines.push('| 지표 | ours | eptium | Δ(ours vs eptium) |');
  lines.push('|------|------|--------|-------------------|');
  lines.push(row('TTD 풀레솔 도달', (r) => r.ttdMs, ms));
  lines.push(row('네트워크 bytes', (r) => r.bytesTotal, mb));
  lines.push(row('range 요청 수', (r) => r.reqCount));
  lines.push(row('peak heap', (r) => r.peakHeapMB, (n) => n.toFixed(0) + ' MB'));
  lines.push('');
  lines.push('## Tier 1b — 부드러움 보조 (frametime, 낮을수록 좋음 ↓)');
  lines.push('');
  lines.push('| 지표 | ours | eptium | Δ |');
  lines.push('|------|------|--------|---|');
  lines.push(row('frametime p50', (r) => r.frametimeMs.p50, ms));
  lines.push(row('frametime p95', (r) => r.frametimeMs.p95, ms));
  lines.push(row('hitch >50ms 수', (r) => r.hitchesGt50));
  lines.push(row('longTask 합(ms)', (r) => r.longTaskTotalMs, ms));
  lines.push('');
  lines.push('## Tier 2 — fps (실GPU headed, 보조; headless면 무효)');
  lines.push('');
  lines.push(`fps≈1000/p50 — ours **${ours.fpsFromP50}** · eptium **${eptium.fpsFromP50}**. 자동화 브라우저 fps라 2급. headless swiftshader면 이 줄 무시.`);
  lines.push('');
  if (!ours.ok || !eptium.ok) {
    lines.push('## ⚠️ 측정 한계');
    if (!ours.ok) lines.push(`- ours 실패: ${ours.error}`);
    if (!eptium.ok) lines.push(`- eptium 실패: ${eptium.error}`);
    lines.push('');
  }
  return lines.join('\n');
}
```

- [ ] **Step 4: selftest 통과 확인**

Run: `npx tsx scripts/bench/selftest.ts`
Expected: 모든 `ok:` 라인 + `selftest passed`, exit 0.

- [ ] **Step 5: Commit**

```bash
git add scripts/bench/report.ts scripts/bench/selftest.ts
git commit -m "feat(bench): 리포트 렌더러(4축 표+품질증인) + selftest"
```

---

### Task 5: 양쪽 오케스트레이션 + 출력 + e2e

**Files:**
- Modify: `scripts/compare-eptium.ts` (main 확장 + dev 서버 보장)
- Create: `docs/bench/eptium-autzen.md` (실행 산출물)
- Create: `docs/bench/eptium-autzen.json` (실행 산출물)

**Interfaces:**
- Consumes: `measureTarget`, `renderReport`, `BenchMeta`.
- Produces: `npm run bench:eptium` → 양쪽 측정 + 리포트 파일 2개.

- [ ] **Step 1: dev 서버 보장 + main 확장**

`scripts/compare-eptium.ts`에 import 추가 및 `main()` 교체:
```ts
import { spawn, type ChildProcess } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { renderReport } from './bench/report';
import type { BenchMeta } from './bench/types';

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
    if (await reachable('http://localhost:5173')) return () => child.kill();
    await sleep(500);
  }
  child.kill();
  throw new Error('dev server failed to start on :5173 (run `npm run dev` 수동)');
}

async function main() {
  const cfg = parseArgs();
  console.log('[bench] config', JSON.stringify(cfg));
  const browser = await chromium.launch({ headless: false });
  const stopDev = cfg.targets.includes('ours') ? await ensureDevServer() : () => {};
  try {
    const results: Record<string, any> = {};
    for (const t of cfg.targets) {
      const url =
        t === 'ours'
          ? 'http://localhost:5173/?ds=autzen'
          : `https://viewer.copc.io/?copc=${AUTZEN_URL}`;
      console.log(`[bench] measuring ${t} …`);
      results[t] = await measureTarget(browser, t, url, cfg);
      console.log(`[bench] ${t} ok=${results[t].ok} pts=${results[t].pointsSelected} ttd=${results[t].ttdMs}ms`);
    }
    const meta: BenchMeta = {
      dataset: 'autzen',
      datasetUrl: AUTZEN_URL,
      msse: cfg.msse,
      secs: cfg.secs,
      throttle: cfg.throttle,
      timestamp: new Date().toISOString(),
    };
    const ours = results.ours ?? null;
    const eptium = results.eptium ?? null;
    if (ours && eptium) {
      mkdirSync('docs/bench', { recursive: true });
      writeFileSync('docs/bench/eptium-autzen.md', renderReport(ours, eptium, meta));
      writeFileSync(
        'docs/bench/eptium-autzen.json',
        JSON.stringify({ meta, ours, eptium }, null, 2),
      );
      console.log('[bench] wrote docs/bench/eptium-autzen.{md,json}');
    } else {
      console.log('[bench] single target — JSON only');
      console.log(JSON.stringify(results, null, 2));
    }
  } finally {
    await browser.close();
    stopDev();
  }
}
```

- [ ] **Step 2: e2e 실행 (양쪽, 매칭 msse=32)**

Run: `npm run bench:eptium`
Expected: headed Chromium이 우리 dev(localhost:5173)와 Eptium을 차례로 측정, `docs/bench/eptium-autzen.md`/`.json` 생성. 콘솔에 양쪽 `ok=true pts=… ttd=…ms`.

- [ ] **Step 3: 수용 기준 점검 (생성된 리포트 확인)**

Run: `cat docs/bench/eptium-autzen.md`
점검(이진 판정):
- 품질 증인 표에 양쪽 `numberOfPointsSelected`가 있고 **서로 근접**(±15% 이내; 크게 벌어지면 msse 정규화 실패 → 재현/조사).
- Tier 1a 표에 TTD·bytes·req수·peakHeap이 **ours/eptium/Δ** 3열로.
- 조건 줄에 `msse=32 · autzen · 네트워크 none` 명시.
- 양쪽 `glRenderer`가 기록됨(실 GPU 증거). 헤드리스 fps를 표 본문 지표로 쓰지 않음(Tier 2 보조 문단만).
- 실패 타깃이 있으면 "측정 한계" 섹션에 명시(조용한 실패 없음).

- [ ] **Step 4: 재현성 스모크 (2회차 동일 조건)**

Run: `npm run bench:eptium` (다시)
Expected: 1a 지표가 1회차와 합리적 분산 내(±부팅/캐시 변동). `ok:true` 재현.

- [ ] **Step 5: Commit (리포트 포함)**

```bash
git add scripts/compare-eptium.ts docs/bench/eptium-autzen.md docs/bench/eptium-autzen.json
git commit -m "feat(bench): 양쪽 오케스트레이션 + autzen 오라클 리포트 생성"
```

---

## Self-Review

**Spec coverage** (spec의 수용 기준 → 태스크 매핑):
- autzen 양쪽 로드 → PoC로 선확인 + Task 3/5 e2e.
- 한 명령 자동 측정·재현 → Task 5 `npm run bench:eptium` (dev 서버 자동 기동) + Step 4 재현 스모크.
- 1a 4지표 양쪽+차이+조건 한 줄 → Task 4 `renderReport` + Task 5 Step 3 점검.
- scene 접근 가부/한계 명시, 조용한 실패 없음 → `BenchResult.error` + 리포트 "측정 한계" 섹션 + `glRenderer`.
- fps 2급 분리, 헤드리스 fps 표 제외 → Task 4 Tier 2 문단.
- `?perf` 측정 중복 안 함 → 우리 측도 동일 프로브로 대칭 측정(측정 로직 단일 = `probe.ts`; `?perf`와 별개지만 신호 정의는 동일 Cesium 통계). **주의**: spec은 "`?perf` JSON 수집"을 적었으나 PoC로 양쪽 `window.viewer` 대칭 구동이 더 공정함이 확인됨 → 대칭 프로브로 상향(측정 로직은 여전히 단일 모듈, 중복 아님).

**Placeholder scan:** TBD/TODO 없음. 모든 코드 단계에 실제 코드. 검증 명령·기대출력 구체.

**Type consistency:** `BenchResult`/`BenchMeta`/`BenchConfig`(types.ts) ↔ probe `StatSample` ↔ report 시그니처 일치. `measureTarget`/`renderReport`/`pctDelta` 시그니처가 호출부와 일치. `findTilesetIndex` 등 프로브 함수명이 Task 3 호출과 일치.

**조정 메모:** Task 5의 dev 서버 자동 기동(`npx vite`)이 환경에 따라 실패하면 에러를 throw하고 "수동 `npm run dev`" 안내 — 조용한 실패 아님. 자동 기동이 불안정하면 수동 2-터미널로 폴백(기능 동일).
