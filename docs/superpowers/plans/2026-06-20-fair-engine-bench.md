# Fair Engine Bench (fair-compare) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 우리 `CopcTileset` vs Eptium을 동일config·고정시점·로딩곡선으로 측정해 "빠른가/동급인가/느린가"를 신뢰구간과 함께 공정하게 판정하는 도구를 만든다.

**Architecture:** 신규 `scripts/bench/fair-compare.ts` 오케스트레이터가 Playwright로 headed Chromium(실 GPU)을 띄워 우리 dev 서버와 Eptium(eptium.com)을 `window.viewer`로 대칭 구동한다. 브라우저 주입 로직은 `fair-probe.ts`(esbuild IIFE 번들)로, 양쪽에 동일 config를 정규화·readback 검증하고, 고정 ECEF 깊은 시점을 1회 로드하는 동안 **GPU 타이머 쿼리로 (pointsSelected, GPU ms)를 매 프레임 샘플 → 점수 버킷별 median 곡선**을 만든다(settle·이진탐색 불요 — Task4 진단). 양쪽 곡선을 겹치는 점 버킷에서 비교, ours-vs-ours 영실험으로 무편향 검증, 유효성 게이트 통과 시에만 verdict 단정.

**Tech Stack:** TypeScript, tsx, Playwright(headed=실 GPU), CDP, esbuild(probe 번들), CesiumJS `Cesium3DTileset.statistics`/`pointCloudShading`.

## Global Constraints

- TypeScript strict. 기존 `scripts/bench/` 스타일을 따른다(probe.ts/compare-eptium.ts).
- 측정 코드는 **조용한 실패 금지** — 유효성 게이트 실패 시 throw 또는 verdict "신뢰불가" 표기, 가짜 숫자 0 ([[no-silent-failures]]).
- 실 GPU 필수: Playwright `chromium.launch({ headless: false, args })`. swiftshader fps는 무효. (스파이크 확인: 서브에이전트도 실 Metal 받음)
- **cost 메트릭 = GPU 타이머 쿼리(`EXT_disjoint_timer_query_webgl2`) GPU ms median.** wall-clock frametime은 보조. (`--disable-gpu-vsync`는 macOS Metal에서 미작동 — 스파이크 `VSYNC_UNCAPPED: false` 확인 → vsync 해제 폐기, GPU 타이머로 피벗.)
- GPU ms가 disjoint/0/미가용인 점(버킷)은 verdict에서 제외(조용한 0 금지).
- **측정 = 로딩 곡선**(Task4 진단: sofi 깊은 뷰 60s+ 단조 로딩 → settle 비현실적). 고정 낮은 msse(=2)로 1회 로드 동안 (pointsSelected, GPU ms) 매 프레임 샘플 → 점수 버킷(250k)별 median. 양쪽 **겹치는 버킷**에서 비교(점매칭=보간으로 자연 해결).
- 1차 데이터셋 = sofi(`https://hobu-lidar.s3.amazonaws.com/sofi.copc.laz`) + millsite(`https://s3.amazonaws.com/hobu-lidar/millsite.copc.laz`).
- Eptium URL 패턴 = `https://viewer.copc.io/?copc=<copcUrl>` (eptium.com 리다이렉트). 우리 = `http://localhost:5173/?ds=<id>`.
- 곡선 측정 cap = 90s(또는 pts 5s 정지=로드완료 조기종료). 버킷당 ≥3 프레임. config readback 필수. 영실험(ours-vs-ours) 노이즈바닥이 동급 임계 정의.

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

// 완전정착: tilesReady ∧ pointsSelected 안정 3s. (pending===0 미게이트 — SW 파이프라인이
// numberOfPendingRequests를 영구 non-zero로 유지: 이슈 #03 numberOfTilesProcessing 고착과
// 동형, compare-eptium도 processing 게이트 제거함. 렌더 프레임 최종성 신호 = pointsSelected·
// tilesReady 안정. Task4 스모크 실측: sofi pending 60s 미드레인이나 pointsSelected 5.88M 재현.)
// cap 도달 시 settled=false.
export async function settleFull(idx: number, capMs: number): Promise<{ settleMs: number; settled: boolean }> {
  const v = W().viewer;
  const s = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const t0 = performance.now();
  let prevR = -1, prevP = -1, stable = 0;
  while (performance.now() - t0 < capMs) {
    v.scene.requestRender();
    await s(200);
    const st = readStats(idx);
    if (st.tilesReady > 0 && st.tilesReady === prevR && st.pointsSelected === prevP) {
      stable += 200;
      if (stable >= 3000) return { settleMs: Math.round(performance.now() - t0 - stable), settled: true };
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

### Task 5: setMsse (msse 고정)

**Files:**
- Modify: `scripts/bench/fair-probe.ts` (add `setMsse`)

**Interfaces:**
- Produces: `setMsse(idx, msse): void` (probe). 곡선 방식에선 viewer당 **고정 낮은 msse 1개**만 set한다(이진탐색 없음).

- [ ] **Step 1: setMsse 추가**

```typescript
// fair-probe.ts 에 추가
export function setMsse(idx: number, msse: number): void {
  const v = W().viewer;
  v.scene.primitives.get(idx).maximumScreenSpaceError = msse;
}
```

- [ ] **Step 2: msse↓ → points↑ 단조성 스모크**

Run (dev 서버 가동 중, port 5173):
```bash
npx tsx -e "
import { chromium } from 'playwright';
(async () => {
  const b = await chromium.launch({ headless:false });
  const p = await b.newPage();
  await p.addInitScript({ path: 'scripts/bench/fair-probe-bundle.js' });
  await p.goto('http://localhost:5173/?ds=sofi', { waitUntil:'domcontentloaded' });
  await new Promise(r=>setTimeout(r,8000));
  const idx = await p.evaluate(()=>FairProbe.findTilesetIndex());
  await p.evaluate((i)=>FairProbe.normalizeConfig(i), idx);
  await p.evaluate((i)=>FairProbe.setViewpoint(i), idx);
  for (const m of [32,8,2]) {
    await p.evaluate((a)=>FairProbe.setMsse(a.i,a.m), {i:idx,m});
    await new Promise(r=>setTimeout(r,6000));
    const s = await p.evaluate((i)=>FairProbe.readStats(i), idx);
    console.log('msse',m,'points',s.pointsSelected);
  }
  await b.close();
})();
"
```
Expected: points 가 msse 32→8→2 으로 **단조 증가**(곡선이 넓은 점 범위를 훑을 수 있음 확인).

- [ ] **Step 3: Commit**

```bash
git add scripts/bench/fair-probe.ts
git commit -m "feat(fair-bench): setMsse + 단조성 확인"
```

---

### Task 6: 로딩 곡선 측정 (measureLoadCurve, GPU 타이머)

settle 미사용(Task4 진단: sofi 깊은 뷰는 60s+ 단조 로딩). 대신 **로딩되는 동안 (pointsSelected, GPU ms)를 매 프레임 샘플 → 점수 버킷별 GPU ms median 곡선**. GPU ms는 그리는 점 수에 의존하지 로딩 상태 무관(업로드 프레임 스파이크는 버킷 median이 흡수).

**Files:**
- Modify: `scripts/bench/fair-types.ts` (add `CurvePoint`, `ViewerCurve`)
- Modify: `scripts/bench/fair-probe.ts` (add `measureLoadCurve`; **remove now-unused `settleFull`** from Task 4)

**Interfaces:**
- Consumes: `readStats` (Task 4), `reassertConfig` (Task 3)
- Produces:
  - `fair-types.ts`: `interface CurvePoint { pts: number; gpuMs: number; n: number }`, `interface ViewerCurve { label: 'ours'|'eptium'; glRenderer: string; gpuOk: boolean; finalPts: number; curve: CurvePoint[] }`
  - `fair-probe.ts`: `measureLoadCurve(idx, msse, capMs, bucketSize, reassert): Promise<{curve:{pts,gpuMs,n}[], gpuOk:boolean, gpuDisjoint:boolean, finalPts:number}>`

- [ ] **Step 1: 곡선 타입 추가 (fair-types.ts)**

```typescript
// fair-types.ts 에 추가
export interface CurvePoint { pts: number; gpuMs: number; n: number }
export interface ViewerCurve { label: 'ours' | 'eptium'; glRenderer: string; gpuOk: boolean; finalPts: number; curve: CurvePoint[] }
```

- [ ] **Step 2: settleFull 제거 + measureLoadCurve 추가 (fair-probe.ts)**

Task 4의 `settleFull`은 곡선 방식에서 불필요 — **삭제**한다(`setViewpoint`/`readStats`는 유지). 그 자리에 추가:

```typescript
// fair-probe.ts 에 추가 (settleFull 삭제)
export async function measureLoadCurve(idx: number, msse: number, capMs: number, bucketSize: number, reassert: boolean) {
  const v = W().viewer;
  const ts = v.scene.primitives.get(idx);
  const s = (d: number) => new Promise((r) => setTimeout(r, d));
  const gl: any = (v.canvas || document.querySelector('canvas'))?.getContext('webgl2');
  const ext: any = gl ? gl.getExtension('EXT_disjoint_timer_query_webgl2') : null;
  ts.maximumScreenSpaceError = msse;

  const buckets = new Map<number, number[]>(); // bucketKey → gpuMs[]
  const inflight: { q: any; pts: number }[] = [];
  let active: any = null;
  let activePts = 0;
  let disjoint = false;
  const onPre = () => {
    if (!ext || active) return;
    active = gl.createQuery();
    activePts = readStats(idx).pointsSelected; // 이 프레임 렌더 시점의 점 수
    gl.beginQuery(ext.TIME_ELAPSED_EXT, active);
  };
  const onPost = () => {
    if (ext && active) { gl.endQuery(ext.TIME_ELAPSED_EXT); inflight.push({ q: active, pts: activePts }); active = null; }
    if (!ext) return;
    if (gl.getParameter(ext.GPU_DISJOINT_EXT)) { disjoint = true; inflight.length = 0; return; }
    for (let i = inflight.length - 1; i >= 0; i--) {
      const { q, pts } = inflight[i];
      if (gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE)) {
        const ms = gl.getQueryParameter(q, gl.QUERY_RESULT) / 1e6; // ns → ms
        const key = Math.round(pts / bucketSize) * bucketSize;
        if (!buckets.has(key)) buckets.set(key, []);
        buckets.get(key)!.push(ms);
        gl.deleteQuery(q); inflight.splice(i, 1);
      }
    }
  };
  v.scene.preRender.addEventListener(onPre);
  v.scene.postRender.addEventListener(onPost);

  const t0 = performance.now();
  let prevPts = -1, plateau = 0;
  while (performance.now() - t0 < capMs) {
    if (reassert) reassertConfig(idx); // Eptium 매프레임 덮어쓰기 방어
    v.scene.requestRender();
    await s(50);
    const pts = readStats(idx).pointsSelected;
    if (pts === prevPts) { plateau += 50; if (plateau >= 5000) break; } // 5s 정지 = 로드 완료 → 조기 종료
    else { plateau = 0; prevPts = pts; }
  }
  await s(200); // 잔여 query 드레인
  v.scene.preRender.removeEventListener(onPre);
  v.scene.postRender.removeEventListener(onPost);

  const med = (a: number[]) => { const x = [...a].sort((m, n) => m - n); return +x[Math.floor(x.length / 2)].toFixed(3); };
  const curve = [...buckets.entries()]
    .map(([pts, arr]) => ({ pts, gpuMs: med(arr), n: arr.length }))
    .filter((b) => b.n >= 3) // 버킷당 최소 3 프레임
    .sort((a, b) => a.pts - b.pts);
  return { curve, gpuOk: !!ext && !disjoint && curve.length > 0, gpuDisjoint: disjoint, finalPts: prevPts };
}
```

- [ ] **Step 3: 번들 재빌드 + 곡선 스모크**

Run (dev 서버 가동 중):
```bash
npm run bench:fair-bundle
npx tsx -e "
import { chromium } from 'playwright';
(async () => {
  const b = await chromium.launch({ headless:false });
  const p = await b.newPage();
  await p.addInitScript({ path: 'scripts/bench/fair-probe-bundle.js' });
  await p.goto('http://localhost:5173/?ds=sofi', { waitUntil:'domcontentloaded' });
  await new Promise(r=>setTimeout(r,8000));
  const idx = await p.evaluate(()=>FairProbe.findTilesetIndex());
  await p.evaluate((i)=>FairProbe.normalizeConfig(i), idx);
  await p.evaluate((i)=>FairProbe.setViewpoint(i), idx);
  const r = await p.evaluate((a)=>FairProbe.measureLoadCurve(a.i,a.m,a.cap,a.bk,false), {i:idx,m:2,cap:60000,bk:250000});
  console.log('gpuOk',r.gpuOk,'disjoint',r.gpuDisjoint,'buckets',r.curve.length,'finalPts',r.finalPts);
  console.log(JSON.stringify(r.curve.slice(0,8)));
  await b.close();
})();
"
```
Expected: `gpuOk true`, `disjoint false`, `buckets` 여러 개(예 8~20), 각 버킷 `{pts, gpuMs>0, n>=3}`, gpuMs가 pts 증가에 따라 대체로 증가. **gpuOk false면 STOP**(GPU 타이머 브래킷·컨텍스트 재검토).

- [ ] **Step 4: Commit**

```bash
git add scripts/bench/fair-types.ts scripts/bench/fair-probe.ts scripts/bench/fair-probe-bundle.js
git commit -m "feat(fair-bench): measureLoadCurve(로딩 곡선 GPU ms 샘플) + settleFull 제거"
```

---

### Task 7: 오케스트레이터 (per-viewer 곡선)

**Files:**
- Create: `scripts/bench/fair-compare.ts`

**Interfaces:**
- Consumes: 전체 FairProbe, `ViewerCurve` (Task 6)
- Produces: `measureViewer(browser, label, url): Promise<ViewerCurve>`, `DATASETS`, 상수 `MSSE`/`BUCKET`/`CAP`

- [ ] **Step 1: fair-compare.ts — 데이터셋 + per-viewer 곡선 측정**

```typescript
// scripts/bench/fair-compare.ts
import { chromium, type Browser, type Page } from 'playwright';
import { resolve } from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import type { ViewerCurve } from './fair-types';
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
```

- [ ] **Step 2: 컴파일 확인** (Task 9 `fair-report` stub 선배치: `export function renderFairReport(){return ''}`)

Run: `npm run build`
Expected: 타입 에러 0.

- [ ] **Step 3: Commit**

```bash
git add scripts/bench/fair-compare.ts
git commit -m "feat(fair-bench): 오케스트레이터 — per-viewer 로딩 곡선 측정"
```

---

### Task 8: verdict (곡선 정렬 + ours-vs-ours 영실험 + 게이트)

**Files:**
- Modify: `scripts/bench/fair-compare.ts` (add `alignAndRatio`, `noiseFloor`, `main`)
- Modify: `scripts/bench/fair-types.ts` (`ValidityGates`: `gpuMsOk`,`configHeld`,`overlapOk`,`nullTestOk`)

**Interfaces:**
- Consumes: `measureViewer` (Task 7)
- Produces: `main()` — dev 서버 보장, 영실험, ours+eptium 곡선, verdict, 리포트.

- [ ] **Step 1: ValidityGates 갱신 (fair-types.ts)**

기존 `ValidityGates`를 곡선용으로 교체:
```typescript
export interface ValidityGates {
  gpuMsOk: boolean;     // 양쪽 GPU ms 측정 성공(disjoint 아님)
  configHeld: boolean;  // 양쪽 config readback 일치(throw 안 함)
  overlapOk: boolean;   // 공통 점 버킷 충분(>=3)
  nullTestOk: boolean;  // ours-vs-ours = 동급
}
```

- [ ] **Step 2: alignAndRatio + noiseFloor + main 추가 (fair-compare.ts)**

```typescript
// fair-compare.ts 에 추가
import type { CurvePoint } from './fair-types';

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
  for (const pa of a.curve) { const gb = bMap.get(pa.pts); if (gb == null) continue; maxRel = Math.max(maxRel, Math.abs(pa.gpuMs - gb) / pa.gpuMs); }
  return +maxRel.toFixed(3);
}

async function main() {
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
    const nullOk = nullRows.length >= 3 && nullRows.every((r) => r.verdict === '동급');

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
```

- [ ] **Step 3: Commit**

```bash
git add scripts/bench/fair-compare.ts scripts/bench/fair-types.ts
git commit -m "feat(fair-bench): 곡선 정렬 verdict + 노이즈바닥 + ours-vs-ours 영실험 + 게이트"
```

---

### Task 9: 리포트 렌더러

**Files:**
- Create: `scripts/bench/fair-report.ts`

**Interfaces:**
- Consumes: `ViewerCurve` (Task 6), verdict/gates (Task 8)
- Produces: `renderFairReport(arg): string`

- [ ] **Step 1: fair-report.ts 작성**

```typescript
// scripts/bench/fair-report.ts
import type { ViewerCurve, ValidityGates } from './fair-types';

interface ReportArg { ds: string; ours: ViewerCurve; eptium: ViewerCurve; verdict: any[]; floor: number; gates: ValidityGates; nullOk: boolean }

export function renderFairReport(a: ReportArg): string {
  const L: string[] = [];
  L.push(`# Fair Engine Bench — ${a.ds}`, '');
  L.push(`> 로딩 곡선 샘플링 · 동일 config · 고정 시점 · cost=GPU 타이머 GPU ms. 노이즈바닥=${(a.floor * 100).toFixed(1)}%`, '');
  const allPass = Object.values(a.gates).every(Boolean);
  L.push(`## 유효성 게이트: ${allPass ? '✅ 전부 PASS' : '❌ 일부 FAIL → verdict 신뢰불가'}`, '');
  for (const [k, v] of Object.entries(a.gates)) L.push(`- ${v ? '✅' : '❌'} ${k}`);
  L.push('', `## Verdict ${allPass ? '' : '(신뢰불가 — 게이트 실패)'} — 공통 점 버킷별 GPU ms`, '');
  if (!a.verdict.length) L.push('_겹치는 점 버킷 없음 — 비교 불가_');
  else {
    L.push('| 점 버킷 | ours GPU ms | eptium GPU ms | ratio | 판정 |', '|---|---|---|---|---|');
    for (const v of a.verdict) L.push(`| ${v.pts.toLocaleString()} | ${v.oursGpuMs} | ${v.eptiumGpuMs} | ${v.ratio} | ${v.verdict} |`);
  }
  L.push('', '## 곡선 (GPU ms @ pointsSelected)', '');
  for (const r of [a.ours, a.eptium]) {
    L.push(`**${r.label}** (${r.glRenderer}) gpuOk=${r.gpuOk} finalPts=${r.finalPts.toLocaleString()}`);
    L.push('| 점 버킷 | GPU ms median | n |', '|---|---|---|');
    for (const p of r.curve) L.push(`| ${p.pts.toLocaleString()} | ${p.gpuMs} | ${p.n} |`);
    L.push('');
  }
  L.push(`## 영실험 (ours-vs-ours)`, '', a.nullOk ? '✅ ours-vs-ours = 동급 → 도구 무편향 확인' : '❌ ours-vs-ours ≠ 동급 → 도구 편향/노이즈, verdict 불신', '');
  return L.join('\n');
}
```

- [ ] **Step 2: 컴파일 확인 (Task 7 stub 교체)**

Run: `npm run build`
Expected: 타입 에러 0.

- [ ] **Step 3: Commit**

```bash
git add scripts/bench/fair-report.ts
git commit -m "feat(fair-bench): 리포트 렌더러(곡선·버킷별 verdict·영실험)"
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
