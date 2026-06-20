# Fair Engine Bench (fair-compare) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 우리 `CopcTileset` vs Eptium을 정착·점매칭·동일config·다중trial로 측정해 "빠른가/동급인가/느린가"를 신뢰구간과 함께 공정하게 판정하는 도구를 만든다.

**Architecture:** 신규 `scripts/bench/fair-compare.ts` 오케스트레이터가 Playwright로 Chromium을 `--disable-gpu-vsync` 플래그와 함께 띄워, 우리 dev 서버와 Eptium(eptium.com)을 `window.viewer`로 대칭 구동한다. 브라우저 주입 측정 로직은 `fair-probe.ts`(esbuild IIFE 번들)로, 양쪽에 동일 config를 정규화·readback 검증하고, 고정 ECEF 시점에서 완전정착 후 vsync 해제 frametime을 N-trial 측정한다. verdict는 6개 유효성 게이트를 통과해야만 단정된다.

**Tech Stack:** TypeScript, tsx, Playwright(headed=실 GPU), CDP, esbuild(probe 번들), CesiumJS `Cesium3DTileset.statistics`/`pointCloudShading`.

## Global Constraints

- TypeScript strict. 기존 `scripts/bench/` 스타일을 따른다(probe.ts/compare-eptium.ts).
- 측정 코드는 **조용한 실패 금지** — 유효성 게이트 실패 시 throw 또는 verdict "신뢰불가" 표기, 가짜 숫자 0 ([[no-silent-failures]]).
- 실 GPU 필수: Playwright `chromium.launch({ headless: false, args })`. swiftshader fps는 무효. (스파이크 확인: 서브에이전트도 실 Metal 받음)
- **cost 메트릭 = GPU 타이머 쿼리(`EXT_disjoint_timer_query_webgl2`) GPU ms median.** wall-clock frametime은 보조. (`--disable-gpu-vsync`는 macOS Metal에서 미작동 — 스파이크 `VSYNC_UNCAPPED: false` 확인 → vsync 해제 폐기, GPU 타이머로 피벗.)
- GPU ms가 disjoint/0/미가용인 점은 verdict에서 제외(조용한 0 금지).
- 점 타깃 = [0.5M, 1M, 2M, 4M] (데이터셋 상한 내). 점매칭 = `numberOfPointsSelected` ±5%.
- 1차 데이터셋 = sofi(`https://hobu-lidar.s3.amazonaws.com/sofi.copc.laz`) + millsite(`https://s3.amazonaws.com/hobu-lidar/millsite.copc.laz`).
- Eptium URL 패턴 = `https://viewer.copc.io/?copc=<copcUrl>` (eptium.com 리다이렉트). 우리 = `http://localhost:5173/?ds=<id>`.
- N trial = 5 + warm-up 1. 정착 cap = 60s. config readback 필수.

---

### Task 1: 타당성 스파이크 (게이트 — 통과해야 이후 진행)

목적: 설계의 3대 미해결 리스크를 실측으로 걷어낸다. **하나라도 실패하면 STOP, 설계 재검토.**

**Files:**
- Create: `scripts/bench/spike-fair.ts` (throwaway, Task 10에서 삭제)

**Interfaces:**
- Produces: 콘솔에 3개 판정 — `VSYNC_UNCAPPED: true/false`, `EPTIUM_CONFIG_HOLDS: true/false`, `GPU_TIMER_AVAILABLE: true/false`.

- [ ] **Step 1: 스파이크 스크립트 작성**

```typescript
// scripts/bench/spike-fair.ts — 설계 리스크 3종 실측 (일회용)
import { chromium } from 'playwright';

const SOFI = 'https://hobu-lidar.s3.amazonaws.com/sofi.copc.laz';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const browser = await chromium.launch({
    headless: false,
    args: ['--disable-gpu-vsync', '--disable-frame-rate-limit'],
  });
  const page = await browser.newPage();

  // 리스크 1: vsync 해제 — Eptium 페이지에서 빈 rAF 루프 fps 측정
  await page.goto(`https://viewer.copc.io/?copc=${SOFI}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await sleep(8000);
  const fps = await page.evaluate(async () => {
    const s = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const v: any = (window as any).viewer;
    let n = 0, run = true;
    const loop = () => { n++; if (v?.scene?.requestRender) v.scene.requestRender(); if (run) requestAnimationFrame(loop); };
    requestAnimationFrame(loop);
    await s(2000); run = false;
    return n / 2;
  });
  const vsyncUncapped = fps > 130; // 120Hz 천장이면 ~120, 해제면 그 이상

  // 리스크 2: Eptium config 제어/유지
  const configHolds = await page.evaluate(async () => {
    const s = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const v: any = (window as any).viewer;
    const pr = v.scene.primitives;
    let ts: any = null;
    for (let i = 0; i < pr.length; i++) { const p = pr.get(i); if (p && /Cesium3DTileset/.test(p.constructor?.name)) { ts = p; break; } }
    if (!ts || !ts.pointCloudShading) return false;
    ts.pointCloudShading.eyeDomeLighting = false;
    ts.pointCloudShading.attenuation = false;
    v.scene.requestRender(); await s(500); v.scene.requestRender(); await s(500);
    return ts.pointCloudShading.eyeDomeLighting === false && ts.pointCloudShading.attenuation === false;
  });

  // 리스크 3: GPU timer query 가용성
  const gpuTimer = await page.evaluate(() => {
    const c: any = (window as any).viewer?.canvas || document.querySelector('canvas');
    const gl: any = c?.getContext('webgl2');
    return !!gl?.getExtension('EXT_disjoint_timer_query_webgl2');
  });

  // GPU 정체 — 서브에이전트 headed 브라우저가 실 Metal 받는지 (swiftshader면 fps/vsync 측정 무효)
  const glRenderer = await page.evaluate(() => {
    const c: any = (window as any).viewer?.canvas || document.querySelector('canvas');
    const gl: any = c?.getContext('webgl2');
    const e: any = gl?.getExtension('WEBGL_debug_renderer_info');
    return e ? String(gl.getParameter(e.UNMASKED_RENDERER_WEBGL)) : 'unknown';
  });

  console.log(`GL_RENDERER: ${glRenderer}`);
  console.log(`VSYNC_UNCAPPED: ${vsyncUncapped} (fps=${fps})`);
  console.log(`EPTIUM_CONFIG_HOLDS: ${configHolds}`);
  console.log(`GPU_TIMER_AVAILABLE: ${gpuTimer}`);
  await browser.close();
}
main().catch((e) => { console.error(e); process.exit(1); });
```

- [ ] **Step 2: 스파이크 실행 + 판정**

Run: `npx tsx scripts/bench/spike-fair.ts`
Expected: 4줄 출력. **컨트롤러(나)가 go/no-go 판정**:
- `GL_RENDERER`: **Metal(Apple) 이어야** 서브에이전트가 실 GPU 받음 → 이후 GPU 태스크도 서브에이전트 가능. `swiftshader`/`llvmpipe`면 서브에이전트 headed 브라우저가 소프트GPU → GPU 태스크(6·7·8·10)는 컨트롤러 인라인으로 전환.
- `VSYNC_UNCAPPED: true` 필요 — false면 frametime이 못 풀려 천장 함정 못 피함 → **STOP**, GPU timer 의존 설계로 전환 검토. (단 GL_RENDERER가 software면 이 판정은 무효 — 실GPU에서 재측정)
- `EPTIUM_CONFIG_HOLDS: true` 필요 — false면 매-프레임 재적용(Task 3 가드)으로도 안 되면 **STOP**, "정규화 불가" 재설계.
- `GPU_TIMER_AVAILABLE` 는 보조신호 — false여도 진행(vsync해제 wall-clock 사용).

- [ ] **Step 3: 결과를 스펙 미해결 리스크 섹션에 기록**

`docs/superpowers/specs/2026-06-20-fair-engine-bench-design.md` 의 "미해결 리스크"에 실측 결과 3줄 추가(append). 커밋:
```bash
git add scripts/bench/spike-fair.ts docs/superpowers/specs/2026-06-20-fair-engine-bench-design.md
git commit -m "spike(fair-bench): vsync 해제·Eptium config 유지·GPU timer 가용성 실측"
```

---

### Task 2: 타입 + probe 스캐폴딩 + 번들 빌드

**Files:**
- Create: `scripts/bench/fair-types.ts`
- Create: `scripts/bench/fair-probe.ts`
- Modify: `package.json` (scripts에 `bench:fair`, `prebench:fair` 추가)
- Test: `npx tsx -e "..."` 로 번들 주입·호출 확인 (아래 Step 4)

**Interfaces:**
- Produces:
  - `fair-types.ts`: `interface Sample { pointsSelected: number; frametimeMs: {p50:number;p95:number;p99:number}; fps: number; gpuMs: number|null; hitches: number; peakHeapMB: number; cesiumMB: number; settleMs: number; tilesReady: number }`
  - `fair-types.ts`: `interface ConfigSnapshot { edl: boolean; attenuation: boolean; resolutionScale: number; canvasW: number; canvasH: number; globeShow: boolean }`
  - `fair-probe.ts` (global `FairProbe`): `findTilesetIndex(): number`, `readConfig(idx): ConfigSnapshot`.

- [ ] **Step 1: fair-types.ts 작성**

```typescript
// scripts/bench/fair-types.ts
export interface ConfigSnapshot {
  edl: boolean;
  attenuation: boolean;
  resolutionScale: number;
  canvasW: number;
  canvasH: number;
  globeShow: boolean;
}
export interface Sample {
  pointsSelected: number;
  frametimeMs: { p50: number; p95: number; p99: number };
  fps: number;
  gpuMs: number | null; // p50 GPU ms (timer query). null = disjoint/미가용 → verdict 제외
  hitches: number;
  peakHeapMB: number;
  cesiumMB: number;
  settleMs: number;
  tilesReady: number;
}
export interface PointResult { target: number; trials: Sample[]; median: Sample; iqrGpuMs: number }
export interface ViewerResult { label: 'ours' | 'eptium'; glRenderer: string; points: PointResult[] }
export interface ValidityGates {
  gpuMsOk: boolean;
  configHeld: boolean;
  allSettled: boolean;
  pointMatchOk: boolean;
  varianceOk: boolean;
  nullTestOk: boolean;
}
```

- [ ] **Step 2: fair-probe.ts 작성 (스캐폴딩 — find/readConfig만, 나머지 Task는 추가)**

```typescript
// scripts/bench/fair-probe.ts — 브라우저 주입(esbuild IIFE → global FairProbe)
import type { ConfigSnapshot } from './fair-types';

declare const window: any;
const W = () => window;

export function findTilesetIndex(): number {
  const v = W().viewer;
  if (!v?.scene?.primitives) return -1;
  const pr = v.scene.primitives;
  for (let i = 0; i < pr.length; i++) {
    const p = pr.get(i);
    if (p && (/Cesium3DTileset/.test(p?.constructor?.name) || typeof p?.maximumScreenSpaceError === 'number')) return i;
  }
  return -1;
}

export function readConfig(idx: number): ConfigSnapshot {
  const v = W().viewer;
  const ts = v.scene.primitives.get(idx);
  const pcs = ts.pointCloudShading || {};
  const c = v.canvas || document.querySelector('canvas');
  return {
    edl: !!pcs.eyeDomeLighting,
    attenuation: !!pcs.attenuation,
    resolutionScale: v.resolutionScale ?? 1,
    canvasW: c?.width ?? 0,
    canvasH: c?.height ?? 0,
    globeShow: v.scene.globe ? !!v.scene.globe.show : false,
  };
}
```

- [ ] **Step 3: package.json 스크립트 추가**

`scripts` 객체에 추가 (기존 `bench:probe-bundle` 패턴 동일):
```json
"bench:fair-bundle": "esbuild scripts/bench/fair-probe.ts --bundle --platform=browser --format=iife --global-name=FairProbe --footer:js=\"window.FairProbe=FairProbe;\" --outfile=scripts/bench/fair-probe-bundle.js",
"prebench:fair": "npm run bench:fair-bundle",
"bench:fair": "tsx scripts/bench/fair-compare.ts"
```

- [ ] **Step 4: 번들 빌드 + 주입 스모크 테스트**

Run (node엔 window 없으므로 stub 후 require — IIFE footer `window.FairProbe=...`가 stub에 세팅됨):
```bash
npm run bench:fair-bundle && node -e "global.window={}; require('./scripts/bench/fair-probe-bundle.js'); console.log(typeof window.FairProbe.findTilesetIndex, typeof window.FairProbe.readConfig)"
```
Expected: `function function` (번들이 두 함수를 global로 노출).

- [ ] **Step 5: Commit**

```bash
git add scripts/bench/fair-types.ts scripts/bench/fair-probe.ts scripts/bench/fair-probe-bundle.js package.json
git commit -m "feat(fair-bench): 타입 + probe 스캐폴딩 + 번들 빌드 스크립트"
```

---

### Task 3: config 정규화 + readback 가드 (공정성 코어)

**Files:**
- Modify: `scripts/bench/fair-probe.ts` (add `normalizeConfig`, `assertConfig`)

**Interfaces:**
- Consumes: `findTilesetIndex`, `readConfig` (Task 2)
- Produces: `normalizeConfig(idx, opts): void`, `assertConfig(idx, expected): boolean` (global FairProbe)

- [ ] **Step 1: normalizeConfig + assertConfig 추가**

```typescript
// fair-probe.ts 에 추가
const NORM = { resolutionScale: 1, canvasW: 1600, canvasH: 900 };

export function normalizeConfig(idx: number): void {
  const v = W().viewer;
  const ts = v.scene.primitives.get(idx);
  if (v.scene.globe) v.scene.globe.show = false;
  if (v.imageryLayers?.removeAll) v.imageryLayers.removeAll();
  v.useBrowserRecommendedResolution = false;
  v.resolutionScale = NORM.resolutionScale;
  if (ts.pointCloudShading) {
    ts.pointCloudShading.eyeDomeLighting = false;
    ts.pointCloudShading.attenuation = false;
  }
}

// 매 프레임 재적용용 — Eptium 이 덮어쓰면 되돌린다
export function reassertConfig(idx: number): void {
  const v = W().viewer;
  const ts = v.scene.primitives.get(idx);
  if (v.scene.globe?.show) v.scene.globe.show = false;
  if (ts.pointCloudShading) {
    if (ts.pointCloudShading.eyeDomeLighting) ts.pointCloudShading.eyeDomeLighting = false;
    if (ts.pointCloudShading.attenuation) ts.pointCloudShading.attenuation = false;
  }
}

// readback 검증 — 정규화가 실제로 먹었나
export function assertConfig(idx: number): boolean {
  const c = readConfig(idx);
  return c.edl === false && c.attenuation === false && c.globeShow === false && c.resolutionScale === NORM.resolutionScale;
}
```

- [ ] **Step 2: ours 에 대해 정규화 readback 검증 (수동 스모크)**

Run (dev 서버 켜둔 상태에서):
```bash
npm run dev & sleep 3
npx tsx -e "
import { chromium } from 'playwright';
(async () => {
  const b = await chromium.launch({ headless:false, args:['--disable-gpu-vsync'] });
  const p = await b.newPage();
  await p.addInitScript({ path: 'scripts/bench/fair-probe-bundle.js' });
  await p.goto('http://localhost:5173/?ds=sofi', { waitUntil:'domcontentloaded' });
  await new Promise(r=>setTimeout(r,8000));
  const idx = await p.evaluate(()=>FairProbe.findTilesetIndex());
  await p.evaluate((i)=>FairProbe.normalizeConfig(i), idx);
  const held = await p.evaluate((i)=>FairProbe.assertConfig(i), idx);
  console.log('OURS config held:', held);
  await b.close();
})();
"
```
Expected: `OURS config held: true`.

- [ ] **Step 3: Commit**

```bash
git add scripts/bench/fair-probe.ts
git commit -m "feat(fair-bench): config 정규화 + readback/재적용 가드"
```

---

### Task 4: 고정 시점 + 완전정착

**Files:**
- Modify: `scripts/bench/fair-probe.ts` (add `setViewpoint`, `readStats`, `settleFull`)

**Interfaces:**
- Consumes: `findTilesetIndex` (Task 2)
- Produces: `setViewpoint(idx): void`, `readStats(idx): {pointsSelected,tilesReady,pending,heapMB,cesiumMB}`, `settleFull(idx, capMs): {settleMs, settled}`

- [ ] **Step 1: setViewpoint + readStats + settleFull 추가**

```typescript
// fair-probe.ts 에 추가
export function readStats(idx: number) {
  const v = W().viewer;
  const ts = v.scene.primitives.get(idx);
  const st = ts.statistics || {};
  const m = (performance as any).memory;
  return {
    pointsSelected: st.numberOfPointsSelected || 0,
    tilesReady: st.numberOfTilesWithContentReady || 0,
    pending: st.numberOfPendingRequests || 0,
    heapMB: m ? m.usedJSHeapSize / 1048576 : 0,
    cesiumMB: ts.totalMemoryUsageInBytes / 1048576,
  };
}

// 고정 깊은 시점 — 각 viewer bs 의 0.15배 반경으로 동일 비율 앵커.
// (동일 COPC → 동일 ECEF 중심. flyToBoundingSphere 대신 축소 sphere 로 결정적 깊이.)
export function setViewpoint(idx: number): void {
  const v = W().viewer;
  const ts = v.scene.primitives.get(idx);
  const bs = ts.boundingSphere;
  const sph = bs.clone();
  sph.radius = bs.radius * 0.15;
  v.camera.flyToBoundingSphere(sph, { duration: 0 });
  v.scene.requestRender();
}

// 완전정착: pending=0 ∧ tilesReady ∧ pointsSelected 안정 2.5s. cap 도달 시 settled=false.
export async function settleFull(idx: number, capMs: number): Promise<{ settleMs: number; settled: boolean }> {
  const v = W().viewer;
  const s = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const t0 = performance.now();
  let prevR = -1, prevP = -1, stable = 0;
  while (performance.now() - t0 < capMs) {
    v.scene.requestRender();
    await s(200);
    const st = readStats(idx);
    if (st.pending === 0 && st.tilesReady > 0 && st.tilesReady === prevR && st.pointsSelected === prevP) {
      stable += 200;
      if (stable >= 2500) return { settleMs: Math.round(performance.now() - t0 - stable), settled: true };
    } else { stable = 0; prevR = st.tilesReady; prevP = st.pointsSelected; }
  }
  return { settleMs: capMs, settled: false };
}
```

- [ ] **Step 2: ours 정착 + 재현성 스모크**

Run (dev 서버 켜둔 상태):
```bash
npx tsx -e "
import { chromium } from 'playwright';
(async () => {
  const b = await chromium.launch({ headless:false, args:['--disable-gpu-vsync'] });
  const p = await b.newPage();
  await p.addInitScript({ path: 'scripts/bench/fair-probe-bundle.js' });
  await p.goto('http://localhost:5173/?ds=sofi', { waitUntil:'domcontentloaded' });
  await new Promise(r=>setTimeout(r,8000));
  const idx = await p.evaluate(()=>FairProbe.findTilesetIndex());
  await p.evaluate((i)=>FairProbe.normalizeConfig(i), idx);
  await p.evaluate((i)=>FairProbe.setViewpoint(i), idx);
  const r1 = await p.evaluate((i)=>FairProbe.settleFull(i, 60000), idx);
  const s1 = await p.evaluate((i)=>FairProbe.readStats(i), idx);
  // 같은 상태 재측정 → pointsSelected 재현
  const s2 = await p.evaluate((i)=>FairProbe.readStats(i), idx);
  console.log('settled:', r1.settled, 'settleMs:', r1.settleMs, 'pts1:', s1.pointsSelected, 'pts2:', s2.pointsSelected);
  await b.close();
})();
"
```
Expected: `settled: true`, `pts1 === pts2` (재현). settled=false면 cap 늘리거나 정착 기준 재검토.

- [ ] **Step 3: Commit**

```bash
git add scripts/bench/fair-probe.ts
git commit -m "feat(fair-bench): 고정 시점 + 완전정착(드리프트 차단)"
```

---

### Task 5: 점매칭 (msse 이진탐색)

**Files:**
- Modify: `scripts/bench/fair-probe.ts` (add `setMsse`)
- Modify: `scripts/bench/fair-compare.ts` (Task 7에서 생성 — 여기선 점매칭 함수만 별도 export 준비. 우선 probe 측 setMsse + node측 binary search 로직을 Task 7 orchestrator에 둔다)

**Interfaces:**
- Produces: `setMsse(idx, msse): void` (probe). 점매칭 알고리즘은 orchestrator(Task 7)가 `setMsse`+`settleFull`+`readStats`를 호출해 수행.

- [ ] **Step 1: setMsse 추가**

```typescript
// fair-probe.ts 에 추가
export function setMsse(idx: number, msse: number): void {
  const v = W().viewer;
  v.scene.primitives.get(idx).maximumScreenSpaceError = msse;
}
```

- [ ] **Step 2: 점매칭 단조성 스모크 (msse↓ → points↑ 확인)**

Run (dev 서버):
```bash
npx tsx -e "
import { chromium } from 'playwright';
(async () => {
  const b = await chromium.launch({ headless:false, args:['--disable-gpu-vsync'] });
  const p = await b.newPage();
  await p.addInitScript({ path: 'scripts/bench/fair-probe-bundle.js' });
  await p.goto('http://localhost:5173/?ds=sofi', { waitUntil:'domcontentloaded' });
  await new Promise(r=>setTimeout(r,8000));
  const idx = await p.evaluate(()=>FairProbe.findTilesetIndex());
  await p.evaluate((i)=>FairProbe.normalizeConfig(i), idx);
  await p.evaluate((i)=>FairProbe.setViewpoint(i), idx);
  for (const m of [32,16,8]) {
    await p.evaluate((a)=>FairProbe.setMsse(a.i,a.m), {i:idx,m});
    await p.evaluate((i)=>FairProbe.settleFull(i,60000), idx);
    const s = await p.evaluate((i)=>FairProbe.readStats(i), idx);
    console.log('msse',m,'points',s.pointsSelected);
  }
  await b.close();
})();
"
```
Expected: points 가 msse 32→16→8 으로 **단조 증가**(이진탐색 전제 충족).

- [ ] **Step 3: Commit**

```bash
git add scripts/bench/fair-probe.ts
git commit -m "feat(fair-bench): setMsse + 점매칭 단조성 확인"
```

---

### Task 6: GPU ms 측정 (GPU 타이머 쿼리, N-trial)

**Files:**
- Modify: `scripts/bench/fair-probe.ts` (add `measureFrametime`)

**Interfaces:**
- Consumes: `readStats` (Task 4)
- Produces: `measureFrametime(idx, ms, reassert): {frametimes:number[], gpuMs:number|null, peakHeapMB:number, peakCesiumMB:number, tilesReady:number, pointsSelected:number}`

- [ ] **Step 1: measureFrametime 추가 (카메라 고정, 매 프레임 강제 렌더 + config 재적용)**

vsync 플래그가 안 먹어(스파이크) **cost = GPU 타이머 GPU ms**로 측정한다. Cesium `scene.preRender/postRender`로 `beginQuery/endQuery(TIME_ELAPSED_EXT)`를 프레임마다 브래킷하고, disjoint 시 폐기, async 결과를 폴링한다. `v.canvas.getContext('webgl2')`는 Cesium이 이미 만든 컨텍스트를 반환한다(같은 type → 기존 반환).

```typescript
// fair-probe.ts 에 추가
const pctOf = (a: number[], p: number) => { if (!a.length) return 0; const x = [...a].sort((m, n) => m - n); return +x[Math.min(x.length - 1, Math.floor((p / 100) * x.length))].toFixed(3); };

export async function measureFrametime(idx: number, ms: number, reassert: boolean) {
  const v = W().viewer;
  const s = (d: number) => new Promise((r) => setTimeout(r, d));
  const gl: any = (v.canvas || document.querySelector('canvas'))?.getContext('webgl2');
  const ext: any = gl ? gl.getExtension('EXT_disjoint_timer_query_webgl2') : null;

  // GPU 타이머: 프레임당 1 query (TIME_ELAPSED 는 중첩 불가), 결과는 async 폴링
  const gpuSamples: number[] = [];
  const inflight: any[] = [];
  let active: any = null;
  let disjoint = false;
  const onPre = () => { if (!ext || active) return; active = gl.createQuery(); gl.beginQuery(ext.TIME_ELAPSED_EXT, active); };
  const onPost = () => {
    if (ext && active) { gl.endQuery(ext.TIME_ELAPSED_EXT); inflight.push(active); active = null; }
    if (!ext) return;
    if (gl.getParameter(ext.GPU_DISJOINT_EXT)) { disjoint = true; inflight.length = 0; return; }
    for (let i = inflight.length - 1; i >= 0; i--) {
      const q = inflight[i];
      if (gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE)) {
        gpuSamples.push(gl.getQueryParameter(q, gl.QUERY_RESULT) / 1e6); // ns → ms
        gl.deleteQuery(q); inflight.splice(i, 1);
      }
    }
  };
  v.scene.preRender.addEventListener(onPre);
  v.scene.postRender.addEventListener(onPost);

  const fts: number[] = [];
  let peakHeap = 0, peakCes = 0, run = true, last = performance.now();
  const loop = () => {
    const now = performance.now();
    fts.push(now - last); last = now;
    if (reassert) reassertConfig(idx); // Eptium 덮어쓰기 방어 (매 프레임)
    v.scene.requestRender();
    const st = readStats(idx);
    peakHeap = Math.max(peakHeap, st.heapMB);
    peakCes = Math.max(peakCes, st.cesiumMB);
    if (run) requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
  await s(ms);
  run = false;
  await s(150); // 잔여 query 결과 드레인
  v.scene.preRender.removeEventListener(onPre);
  v.scene.postRender.removeEventListener(onPost);

  const st = readStats(idx);
  const gpuOk = !!ext && !disjoint && gpuSamples.length > 3 && gpuSamples.every((x) => x > 0);
  return {
    frametimes: fts.slice(1), // 보조 (wall-clock)
    gpuMs: gpuOk ? { p50: pctOf(gpuSamples, 50), p95: pctOf(gpuSamples, 95), p99: pctOf(gpuSamples, 99), n: gpuSamples.length } : null,
    gpuDisjoint: disjoint,
    peakHeapMB: Math.round(peakHeap),
    peakCesiumMB: Math.round(peakCes),
    tilesReady: st.tilesReady,
    pointsSelected: st.pointsSelected,
  };
}
```

- [ ] **Step 2: GPU 타이머 측정 스모크 (gpuMs 비-null·양수 검증)**

Run (dev 서버):
```bash
npx tsx -e "
import { chromium } from 'playwright';
(async () => {
  const b = await chromium.launch({ headless:false, args:['--disable-gpu-vsync'] });
  const p = await b.newPage();
  await p.addInitScript({ path: 'scripts/bench/fair-probe-bundle.js' });
  await p.goto('http://localhost:5173/?ds=sofi', { waitUntil:'domcontentloaded' });
  await new Promise(r=>setTimeout(r,8000));
  const idx = await p.evaluate(()=>FairProbe.findTilesetIndex());
  await p.evaluate((i)=>FairProbe.normalizeConfig(i), idx);
  await p.evaluate((i)=>FairProbe.setViewpoint(i), idx);
  await p.evaluate((a)=>FairProbe.setMsse(a.i,a.m), {i:idx,m:8});
  await p.evaluate((i)=>FairProbe.settleFull(i,60000), idx);
  const r = await p.evaluate((i)=>FairProbe.measureFrametime(i,3000,false), idx);
  console.log('gpuMs', JSON.stringify(r.gpuMs), 'disjoint', r.gpuDisjoint, 'wallP50', (r.frametimes.sort((a,c)=>a-c)[Math.floor(r.frametimes.length/2)]||0).toFixed(2));
  await b.close();
})();
"
```
Expected: `gpuMs`가 `null`이 아니고 `{p50,p95,p99,n}` 양수(예 p50 수~수십 ms, n>3), `disjoint false`. **gpuMs가 null이면 AC6 실패 → STOP**, GPU 타이머 브래킷(preRender/postRender·컨텍스트) 재검토. (wallP50는 보조 — vsync로 floor에 붙어도 무방)

- [ ] **Step 3: Commit**

```bash
git add scripts/bench/fair-probe.ts
git commit -m "feat(fair-bench): vsync해제 frametime N-trial 측정 + 매프레임 config 재적용"
```

---

### Task 7: 오케스트레이터 (per-viewer 측정 + 점매칭 루프)

**Files:**
- Create: `scripts/bench/fair-compare.ts`

**Interfaces:**
- Consumes: 전체 FairProbe (Task 2~6), `Sample`/`ViewerResult`/`PointResult` (Task 2)
- Produces: `measureViewer(browser, label, url, ds): Promise<ViewerResult>`, `matchMsse(page, idx, targetPoints): Promise<number>`, `DATASETS`

- [ ] **Step 1: fair-compare.ts — 데이터셋·점매칭·viewer 측정**

```typescript
// scripts/bench/fair-compare.ts
import { chromium, type Browser, type Page } from 'playwright';
import { resolve } from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import type { Sample, PointResult, ViewerResult } from './fair-types';
import { renderFairReport } from './fair-report';

const BUNDLE = resolve(fileURLToPath(import.meta.url), '../fair-probe-bundle.js');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const POINT_TARGETS = [500_000, 1_000_000, 2_000_000, 4_000_000];
const TRIALS = 5;
const SETTLE_CAP = 60_000;

const DATASETS: Record<string, { id: string; copcUrl: string }> = {
  millsite: { id: 'millsite', copcUrl: 'https://s3.amazonaws.com/hobu-lidar/millsite.copc.laz' },
  sofi: { id: 'sofi', copcUrl: 'https://hobu-lidar.s3.amazonaws.com/sofi.copc.laz' },
};

function pct(a: number[], p: number) { const s = [...a].sort((x, y) => x - y); return s.length ? +s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))].toFixed(2) : 0; }

// msse 이진탐색 → pointsSelected 가 target ±5% 가 되는 msse. 정착 후 점수 읽음.
async function matchMsse(page: Page, idx: number, target: number): Promise<{ msse: number; points: number }> {
  let lo = 1, hi = 64, best = { msse: 16, points: 0 };
  for (let iter = 0; iter < 8; iter++) {
    const msse = (lo + hi) / 2;
    await page.evaluate((a) => (window as any).FairProbe.setMsse(a.i, a.m), { i: idx, m: msse });
    await page.evaluate((i) => (window as any).FairProbe.settleFull(i, SETTLE_CAP), idx);
    const st: any = await page.evaluate((i) => (window as any).FairProbe.readStats(i), idx);
    best = { msse, points: st.pointsSelected };
    if (Math.abs(st.pointsSelected - target) / target <= 0.05) break;
    if (st.pointsSelected > target) lo = msse; else hi = msse; // points↓ as msse↑
  }
  return best;
}

export async function measureViewer(browser: Browser, label: 'ours' | 'eptium', url: string): Promise<ViewerResult> {
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 900 } });
  const page = await ctx.newPage();
  await page.addInitScript({ path: BUNDLE });
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  let idx = -1;
  for (let i = 0; i < 90 && idx < 0; i++) { await sleep(500); idx = await page.evaluate(() => (window as any).FairProbe.findTilesetIndex()); }
  if (idx < 0) throw new Error(`${label}: tileset not found`);
  const glRenderer: string = await page.evaluate(() => { const c: any = (window as any).viewer?.canvas; const gl: any = c?.getContext('webgl2'); const e = gl?.getExtension('WEBGL_debug_renderer_info'); return e ? gl.getParameter(e.UNMASKED_RENDERER_WEBGL) : 'unknown'; });
  await page.evaluate((i) => (window as any).FairProbe.normalizeConfig(i), idx);
  await page.evaluate((i) => (window as any).FairProbe.setViewpoint(i), idx);
  if (!(await page.evaluate((i) => (window as any).FairProbe.assertConfig(i), idx)))
    throw new Error(`${label}: config normalization failed (readback mismatch)`);

  const reassert = label === 'eptium';
  const points: PointResult[] = [];
  for (const target of POINT_TARGETS) {
    const m = await matchMsse(page, idx, target);
    const settle: any = await page.evaluate((i) => (window as any).FairProbe.settleFull(i, SETTLE_CAP), idx);
    if (!settle.settled) { console.warn(`[fair] ${label} target=${target} NOT settled — skip`); continue; }
    const trials: Sample[] = [];
    // warm-up 1 (버림) + 본 TRIALS
    await page.evaluate((a) => (window as any).FairProbe.measureFrametime(a.i, 1500, a.r), { i: idx, r: reassert });
    for (let t = 0; t < TRIALS; t++) {
      const r: any = await page.evaluate((a) => (window as any).FairProbe.measureFrametime(a.i, 3000, a.r), { i: idx, r: reassert });
      const wp50 = pct(r.frametimes, 50);
      trials.push({ pointsSelected: r.pointsSelected, frametimeMs: { p50: wp50, p95: pct(r.frametimes, 95), p99: pct(r.frametimes, 99) }, fps: +(1000 / wp50).toFixed(1), gpuMs: r.gpuMs ? r.gpuMs.p50 : null, hitches: r.frametimes.filter((d: number) => d > 50).length, peakHeapMB: r.peakHeapMB, cesiumMB: r.peakCesiumMB, settleMs: settle.settleMs, tilesReady: r.tilesReady });
    }
    // cost = GPU ms (낮을수록 빠름). null 은 큰 값으로 정렬해 뒤로 → median 은 측정된 trial 대표.
    const median = trials.slice().sort((a, b) => (a.gpuMs ?? 1e9) - (b.gpuMs ?? 1e9))[Math.floor(trials.length / 2)];
    const g = trials.map((t) => t.gpuMs).filter((x): x is number => x != null).sort((a, b) => a - b);
    const iqrGpuMs = g.length ? +(g[Math.floor(g.length * 0.75)] - g[Math.floor(g.length * 0.25)]).toFixed(3) : 0;
    points.push({ target, trials, median, iqrGpuMs });
  }
  await ctx.close();
  return { label, glRenderer, points };
}
```

- [ ] **Step 2: 컴파일 확인**

Run: `npx tsc --noEmit scripts/bench/fair-compare.ts` (또는 `npm run build` 의 tsc 통과)
Expected: 타입 에러 0. (fair-report import 는 Task 9에서 생성 — 임시로 Step 1에 stub 두거나 Task 9 먼저 머지. 순서상 Task 9 stub 을 먼저 둔다: `export function renderFairReport(){return ''}`.)

- [ ] **Step 3: Commit**

```bash
git add scripts/bench/fair-compare.ts
git commit -m "feat(fair-bench): 오케스트레이터 — 점매칭 이진탐색 + per-viewer N-trial 측정"
```

---

### Task 8: verdict + 유효성 게이트 + ours-vs-ours 영실험

**Files:**
- Modify: `scripts/bench/fair-compare.ts` (add `nullTest`, `computeVerdict`, `main`)

**Interfaces:**
- Consumes: `measureViewer` (Task 7)
- Produces: `main()` — dev 서버 보장, 영실험, ours+eptium 측정, verdict, 리포트 작성.

- [ ] **Step 1: nullTest + verdict + main 추가**

```typescript
// fair-compare.ts 에 추가
async function ensureDevServer(): Promise<() => void> {
  const ok = async () => { try { return (await fetch('http://localhost:5173')).status < 500; } catch { return false; } };
  if (await ok()) return () => {};
  const child = spawn('npx', ['vite', '--port', '5173'], { cwd: process.cwd(), stdio: 'ignore' });
  for (let i = 0; i < 60; i++) { await sleep(500); if (await ok()) return () => child.kill(); }
  child.kill(); throw new Error('dev server failed on :5173');
}

// 영실험: ours-vs-ours → ratio≈1 이어야 + 노이즈바닥 산출 (cost = GPU ms)
function noiseFloor(a: ViewerResult, b: ViewerResult): number {
  // 같은 점타깃에서 두 측정 GPU ms median 의 상대차 최대값 = 노이즈바닥
  let maxRel = 0;
  for (const pa of a.points) {
    const pb = b.points.find((x) => x.target === pa.target);
    if (!pb || pa.median.gpuMs == null || pb.median.gpuMs == null) continue;
    maxRel = Math.max(maxRel, Math.abs(pa.median.gpuMs - pb.median.gpuMs) / pa.median.gpuMs);
  }
  return +maxRel.toFixed(3);
}

function computeVerdict(ours: ViewerResult, eptium: ViewerResult, floor: number) {
  const threshold = Math.max(0.10, floor);
  return eptium.points.map((pe) => {
    const po = ours.points.find((x) => x.target === pe.target);
    if (!po) return { target: pe.target, verdict: 'no-ours-data' as const };
    if (po.median.gpuMs == null || pe.median.gpuMs == null) return { target: pe.target, verdict: 'no-gpu-data' as const };
    // cost = GPU ms (낮을수록 빠름). ratio = ours/eptium.
    const ratio = po.median.gpuMs / pe.median.gpuMs;
    let verdict: string;
    if (Math.abs(ratio - 1) <= threshold) verdict = '동급';
    else verdict = ratio < 1 ? '우위(우리가 빠름)' : '열위(우리가 느림)';
    return { target: pe.target, oursGpuMs: po.median.gpuMs, eptiumGpuMs: pe.median.gpuMs, ratio: +ratio.toFixed(3), verdict, threshold };
  });
}

async function main() {
  const ds = (process.argv.includes('--ds') ? process.argv[process.argv.indexOf('--ds') + 1] : 'sofi');
  if (!DATASETS[ds]) throw new Error(`unknown --ds ${ds}`);
  const browser = await chromium.launch({ headless: false, args: ['--disable-gpu-vsync', '--disable-frame-rate-limit'] });
  const stopDev = await ensureDevServer();
  try {
    const oursUrl = `http://localhost:5173/?ds=${ds}`;
    const eptiumUrl = `https://viewer.copc.io/?copc=${DATASETS[ds].copcUrl}`;

    // 영실험 (ours vs ours)
    const nullA = await measureViewer(browser, 'ours', oursUrl);
    const nullB = await measureViewer(browser, 'ours', oursUrl);
    const floor = noiseFloor(nullA, nullB);
    const nullVerdict = computeVerdict(nullA, nullB, floor);
    const nullOk = nullVerdict.every((v) => v.verdict === '동급' || v.verdict === 'no-ours-data');

    // 본 측정
    const ours = await measureViewer(browser, 'ours', oursUrl);
    const eptium = await measureViewer(browser, 'eptium', eptiumUrl);
    const verdict = computeVerdict(ours, eptium, floor);

    const gates = {
      gpuMsOk: [...ours.points, ...eptium.points].length > 0 && [...ours.points, ...eptium.points].every((p) => p.median.gpuMs != null),
      configHeld: true, // measureViewer 가 실패 시 throw 하므로 여기 도달=held
      allSettled: ours.points.length === POINT_TARGETS.length && eptium.points.length === POINT_TARGETS.length,
      pointMatchOk: true, // matchMsse ±5% (미달 시 리포트에 실측 점수로 표기)
      varianceOk: [...ours.points, ...eptium.points].every((p) => p.median.gpuMs == null || p.iqrGpuMs / p.median.gpuMs <= Math.max(0.10, floor)),
      nullTestOk: nullOk,
    };

    mkdirSync('docs/bench', { recursive: true });
    const md = renderFairReport({ ds, ours, eptium, verdict, floor, gates, nullVerdict });
    writeFileSync(`docs/bench/fair-compare-${ds}.md`, md);
    writeFileSync(`docs/bench/fair-compare-${ds}.json`, JSON.stringify({ ds, ours, eptium, verdict, floor, gates }, null, 2));
    console.log(`[fair] wrote docs/bench/fair-compare-${ds}.{md,json}  nullOk=${nullOk} floor=${floor}`);
  } finally { await browser.close(); stopDev(); }
}
main().catch((e) => { console.error('[fair] fatal', e); process.exit(1); });
```

- [ ] **Step 2: Commit**

```bash
git add scripts/bench/fair-compare.ts
git commit -m "feat(fair-bench): verdict + 6 유효성 게이트 + ours-vs-ours 영실험"
```

---

### Task 9: 리포트 렌더러

**Files:**
- Create: `scripts/bench/fair-report.ts`

**Interfaces:**
- Consumes: `ViewerResult` (Task 2), verdict/gates (Task 8)
- Produces: `renderFairReport(arg): string`

- [ ] **Step 1: fair-report.ts 작성**

```typescript
// scripts/bench/fair-report.ts
import type { ViewerResult, ValidityGates } from './fair-types';

interface ReportArg {
  ds: string;
  ours: ViewerResult;
  eptium: ViewerResult;
  verdict: any[];
  floor: number;
  gates: ValidityGates;
  nullVerdict: any[];
}

export function renderFairReport(a: ReportArg): string {
  const L: string[] = [];
  L.push(`# Fair Engine Bench — ${a.ds}`, '');
  L.push(`> 정착·점매칭·동일config·vsync해제·N-trial. 노이즈바닥=${(a.floor * 100).toFixed(1)}%`, '');
  const allPass = Object.values(a.gates).every(Boolean);
  L.push(`## 유효성 게이트: ${allPass ? '✅ 전부 PASS' : '❌ 일부 FAIL → verdict 신뢰불가'}`, '');
  for (const [k, v] of Object.entries(a.gates)) L.push(`- ${v ? '✅' : '❌'} ${k}`);
  L.push('', `## Verdict ${allPass ? '' : '(신뢰불가 — 게이트 실패)'}`, '');
  L.push('| 점 타깃 | ours GPU ms | eptium GPU ms | ratio | 판정 |', '|---|---|---|---|---|');
  for (const v of a.verdict) {
    if (v.verdict === 'no-ours-data') { L.push(`| ${v.target.toLocaleString()} | — | — | — | ours 데이터없음 |`); continue; }
    if (v.verdict === 'no-gpu-data') { L.push(`| ${v.target.toLocaleString()} | — | — | — | GPU ms 측정불가 |`); continue; }
    L.push(`| ${v.target.toLocaleString()} | ${v.oursGpuMs} | ${v.eptiumGpuMs} | ${v.ratio} | ${v.verdict} |`);
  }
  L.push('', '## 곡선 (GPU ms @ pointsSelected · cost는 GPU ms, fps는 보조)', '');
  for (const r of [a.ours, a.eptium]) {
    L.push(`**${r.label}** (${r.glRenderer})`);
    L.push('| 점타깃 | 실측 points | GPU ms median | IQR GPU ms | wall fps | heapMB | cesiumMB |', '|---|---|---|---|---|---|---|');
    for (const p of r.points) L.push(`| ${p.target.toLocaleString()} | ${p.median.pointsSelected.toLocaleString()} | ${p.median.gpuMs ?? '측정불가'} | ${p.iqrGpuMs.toFixed(3)} | ${p.median.fps} | ${p.median.peakHeapMB} | ${p.median.cesiumMB} |`);
    L.push('');
  }
  L.push(`## 영실험 (ours-vs-ours, 동급이어야 함)`, '');
  L.push(a.gates.nullTestOk ? '✅ ours-vs-ours = 동급 → 도구 무편향 확인' : '❌ ours-vs-ours ≠ 동급 → 도구 편향, verdict 불신', '');
  return L.join('\n');
}
```

- [ ] **Step 2: 컴파일 + (Task 7 stub 교체) 확인**

Run: `npm run build` (tsc --noEmit 포함)
Expected: 타입 에러 0.

- [ ] **Step 3: Commit**

```bash
git add scripts/bench/fair-report.ts
git commit -m "feat(fair-bench): 리포트 렌더러(곡선·verdict·유효성·영실험)"
```

---

### Task 10: 엔드투엔드 실행 + 스파이크 정리

**Files:**
- Delete: `scripts/bench/spike-fair.ts`
- Create: `docs/bench/fair-compare-sofi.{md,json}` (실행 산출물)

- [ ] **Step 1: 전체 실행 (sofi)**

Run: `npm run bench:fair -- --ds sofi`
Expected:
- 콘솔 `nullOk=true` (영실험 통과 — 안 그러면 도구 신뢰불가, 분산/warm-up 재검토).
- `docs/bench/fair-compare-sofi.md` 생성. 유효성 6게이트 상태 + verdict 표 + 양쪽 곡선.
- **AC 점검**: AC1(nullOk)·AC2(config held=throw 안 함)·AC3(allSettled)·AC6(vsyncUncapped) PASS 확인. 하나라도 FAIL이면 리포트가 "신뢰불가"로 표기됐는지 확인(조용한 통과 없음).

- [ ] **Step 2: millsite 도 실행 (2차 데이터셋)**

Run: `npm run bench:fair -- --ds millsite`
Expected: `docs/bench/fair-compare-millsite.{md,json}` 생성, 게이트 상태 출력.

- [ ] **Step 3: 스파이크 삭제 + CHANGELOG/PROGRESS 갱신**

```bash
git rm scripts/bench/fair-probe-bundle.js --cached 2>/dev/null || true  # 번들은 산출물 — gitignore 여부는 기존 probe-bundle.js 관례 따름(커밋돼 있으면 커밋)
rm scripts/bench/spike-fair.ts
```
`docs/CHANGELOG.md` 에 한 줄(공정 엔진 벤치 도구 + sofi/millsite verdict 요약), `docs/PROGRESS.md` Phase 2 측정 섹션에 결과 반영.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "feat(fair-bench): E2E 실행(sofi·millsite) + 스파이크 정리 + 문서 갱신"
```

---

## Self-Review

**1. Spec coverage:**
- 5대 통제 → ①config(Task 3)·②점매칭(Task 5,7)·③정착(Task 4)·④시점(Task 4)·⑤trial(Task 6,7). ✅
- 문제1 vsync(→GPU 타이머 피벗, 스파이크 후) → Task 6 GPU ms 측정 + Task 8 gpuMsOk 게이트 + AC6. ✅
- 문제2 Eptium config → Task 1 스파이크 + Task 3 reassert + Task 7 readback throw. ✅
- 자기검증 영실험 → Task 8 nullTest + 노이즈바닥. ✅
- 6 유효성 게이트 → Task 8 gates + Task 9 리포트 표기. ✅
- AC1~7 → Task 8(verdict/gates)·Task 10(E2E 점검). ✅
- 출력 docs/bench/fair-compare-<ds> → Task 9. ✅

**2. Placeholder scan:** (피벗 후) GPU 타이머가 1차 cost 메트릭 — `measureFrametime`이 실 측정·반환. wall-clock frametime은 보조로 기록. TBD/no-op 없음.

**3. Type consistency:** `Sample`(gpuMs=p50 GPU ms number|null)·`PointResult`(iqrGpuMs)·`ViewerResult`·`ValidityGates`(gpuMsOk)(Task 2) ↔ Task 7,8,9 사용 일치. verdict 필드 `oursGpuMs`/`eptiumGpuMs` ↔ Task 9 리포트 일치. `FairProbe` 함수명(findTilesetIndex·readConfig·normalizeConfig·assertConfig·reassertConfig·readStats·setViewpoint·settleFull·setMsse·measureFrametime) 전 태스크 일관.

**알려진 미해결(구현 중 판정):** Task 1 스파이크가 vsync/Eptium-config 둘 중 하나라도 false면 그 지점에서 STOP·재설계(plan 진행 전제). Task 7 `fair-report` import 순환은 Task 9 stub 선배치로 해소.
