# 점 피킹 정보 조회 (Tier1 #3-A) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 점을 클릭하면 그 점의 정확한 경위도·고도 + LAS 속성을 보여주는 `pickPoint` free 함수(라이브러리) + 데모 패널을 추가한다.

**Architecture:** Cesium 내장 `scene.pick`(소유권)+`scene.pickPosition`(위치)+#1 `getProperty`(속성)를 조합한 순수 free 함수 `pickPoint(tileset, scene, windowPosition)`. 렌더러 손코딩 0. 데모는 클릭 핸들러로 이 함수를 호출해 오버레이 패널을 갱신. 핵심 로직은 fake scene/feature 주입으로 WebGL 없이 결정적 테스트.

**Tech Stack:** TypeScript(strict), CesiumJS(`scene.pick`/`pickPosition`/`Cartographic`/`ScreenSpaceEventHandler`), tsup(라이브러리 빌드), tsx(헤드리스 테스트), Playwright(브라우저 스모크).

## Global Constraints

- 렌더러/picking primitive **손코딩 0** — Cesium 내장 `scene.pick`/`scene.pickPosition`만 사용(ADR-004 위임 규율).
- 신규 의존성 **0**. 기존 라이브러리 로직(`src/` 기존 9파일) **무변경** — 신규 `src/picking.ts` + `index.ts` export 1줄만.
- `pickPoint` 는 **free export 함수**(duck-typed 메서드 아님) — `rampStyle` 선례와 일관, 완전 타입.
- 소유권 판정: `picked.primitive !== tileset` → `undefined`(globe 관통·하늘·타 tileset 거름).
- [[no-silent-failures]]: pickPosition 미지원/실패는 위치 undefined로 **degraded 반환**(속성은 유지), throw 아님.
- 범위 밖(YAGNI): 옥트리 최근접점 검색·측정 스냅·하이라이트·drill-pick.
- 역사 기록(PROGRESS/CHANGELOG/adr/handoff/기존 superpowers specs) **재작성 금지** — append-only.

---

### Task 1: 라이브러리 — `pickPoint` (TDD) + export + README

**Files:**
- Create: `scripts/check-picking.ts` (헤드리스 결정적 테스트)
- Create: `src/picking.ts` (`pickPoint` + `PickedPoint`)
- Modify: `src/index.ts` (export 추가)
- Modify: `README.md:88` 뒤 (pickPoint 사용 스니펫)

**Interfaces:**
- Consumes: 없음 (Cesium `scene.pick`/`pickPosition`, `Cartographic.fromCartesian`).
- Produces: `pickPoint(tileset: Cesium3DTileset, scene: Scene, windowPosition: Cartesian2): PickedPoint | undefined`.
  `interface PickedPoint { position?: Cartesian3; cartographic?: Cartographic; featureId: number; attributes: Record<string, number | string>; }`. Task 2가 이 함수를 호출.

- [ ] **Step 1: 실패하는 테스트 작성 — `scripts/check-picking.ts`**

```ts
// 점 피킹 헬퍼 결정적 테스트 — fake scene/feature 주입(WebGL 불필요). Cesium 수학만 실제 사용.
import { Cartesian2, Cartesian3, Math as CesiumMath } from 'cesium';
import { pickPoint } from '../src/picking';

let failed = 0;
function check(name: string, cond: boolean): void {
  console.log(`${cond ? 'ok  ' : 'FAIL'} — ${name}`);
  if (!cond) failed++;
}

const tileset = {} as never; // 소유권 판정용 참조 정체성

const feature = {
  primitive: tileset,
  featureId: 7,
  getPropertyIds: () => ['Classification', 'Intensity'],
  getProperty: (id: string) => ({ Classification: 5, Intensity: 5120 } as Record<string, number>)[id],
};

function makeScene(picked: unknown, position: Cartesian3 | undefined, supported = true): never {
  return { pick: () => picked, pickPositionSupported: supported, pickPosition: () => position } as never;
}

const winPos = new Cartesian2(100, 100) as never;
const worldPos = Cartesian3.fromDegrees(-123.07, 44.06, 100);

// (a) 소유 feature → 위치+속성
{
  const r = pickPoint(tileset, makeScene(feature, worldPos), winPos);
  check('a: 결과 정의됨', !!r);
  check('a: featureId=7', r?.featureId === 7);
  check('a: attributes', r?.attributes.Classification === 5 && r?.attributes.Intensity === 5120);
  const lon = r?.cartographic ? CesiumMath.toDegrees(r.cartographic.longitude) : NaN;
  const lat = r?.cartographic ? CesiumMath.toDegrees(r.cartographic.latitude) : NaN;
  check('a: lon≈-123.07', Math.abs(lon - -123.07) < 1e-4);
  check('a: lat≈44.06', Math.abs(lat - 44.06) < 1e-4);
  check('a: height≈100', !!r?.cartographic && Math.abs(r.cartographic.height - 100) < 1e-2);
}
// (b) 타 primitive → undefined
{
  const r = pickPoint(tileset, makeScene({ primitive: {} }, worldPos), winPos);
  check('b: 타 primitive → undefined', r === undefined);
}
// (c) 하늘(pick undefined) → undefined
{
  const r = pickPoint(tileset, makeScene(undefined, worldPos), winPos);
  check('c: 하늘 → undefined', r === undefined);
}
// (d) pickPosition 미지원 → 위치 undefined·속성 존재
{
  const r = pickPoint(tileset, makeScene(feature, undefined, false), winPos);
  check('d: 결과 정의됨', !!r);
  check('d: position undefined', r?.position === undefined);
  check('d: cartographic undefined', r?.cartographic === undefined);
  check('d: attributes 존재', r?.attributes.Classification === 5);
}

if (failed > 0) { console.error(`\nC-picking FAIL (${failed})`); process.exit(1); }
console.log('\nC-picking PASS ✅');
```

- [ ] **Step 2: 테스트 실행 → 실패 확인**

Run: `npx tsx scripts/check-picking.ts`
Expected: FAIL — `Cannot find module '../src/picking'` (또는 `pickPoint is not a function`). 모듈 부재로 RED.

- [ ] **Step 3: 구현 — `src/picking.ts`**

```ts
// 클릭한 점의 위치+LAS 속성 조회. Cesium 내장 pick/pickPosition + #1 batch table 만 사용(렌더러 손코딩 0).
// 페이지측 헬퍼(Cesium import 허용, copc-style.ts 와 동일 레이어).
import { Cartographic } from 'cesium';
import type { Cartesian2, Cartesian3, Cesium3DTileFeature, Cesium3DTileset, Scene } from 'cesium';

export interface PickedPoint {
  position?: Cartesian3; // ECEF (scene.pickPosition; 미지원/실패 시 undefined)
  cartographic?: Cartographic; // lon/lat(rad)·height(m), position 에서 파생
  featureId: number; // BATCH_ID
  attributes: Record<string, number | string>; // 노출된 LAS 속성(우리 점이면 항상 존재)
}

/**
 * windowPosition 의 점이 `tileset` 소유면 그 점의 위치+속성을, 아니면 undefined.
 * globe 관통·하늘·타 tileset 은 undefined 로 걸러진다.
 */
export function pickPoint(
  tileset: Cesium3DTileset,
  scene: Scene,
  windowPosition: Cartesian2,
): PickedPoint | undefined {
  const picked = scene.pick(windowPosition) as Cesium3DTileFeature | undefined;
  // 소유권: 우리 tileset 의 feature 만. globe/하늘/타 tileset 은 거른다.
  if (!picked || picked.primitive !== tileset) return undefined;

  const position = scene.pickPositionSupported ? scene.pickPosition(windowPosition) : undefined;
  const cartographic = position ? Cartographic.fromCartesian(position) : undefined;

  const attributes: Record<string, number | string> = {};
  for (const id of picked.getPropertyIds()) attributes[id] = picked.getProperty(id);

  return { position, cartographic, featureId: picked.featureId, attributes };
}
```

- [ ] **Step 4: 테스트 실행 → 통과 확인**

Run: `npx tsx scripts/check-picking.ts`
Expected: 전 체크 `ok`, 마지막 줄 `C-picking PASS ✅`, exit 0.

- [ ] **Step 5: `src/index.ts` 에 export 추가**

기존 export 블록(끝)에 2줄 추가:
```ts
export { pickPoint } from './picking';
export type { PickedPoint } from './picking';
```

- [ ] **Step 6: 빌드 + 라이브러리 출하 + 회귀 확인**

Run: `npm run build`
Expected: `tsc --noEmit` 타입에러 0 (`src/picking.ts` strict·noUnusedLocals 통과) + vite demo-dist 산출.

Run: `npm run build:lib && grep -c "pickPoint" dist/index.d.ts`
Expected: tsup 통과 + `dist/index.d.ts` 에 `pickPoint` 시그니처 존재(grep ≥ 1).

Run: `npm run verify`
Expected: C1 Oregon PASS (라이브러리 기존 로직 무변경 → 회귀 0).

- [ ] **Step 7: README 에 pickPoint 사용 추가**

`README.md` 의 pick 예제 코드블록(``` 닫힘, 현 line 88) **뒤에** 삽입:
```markdown

`pickPoint(tileset, scene, windowPosition)` is a higher-level helper: one call returns the clicked point's exact location **and** attributes, or `undefined` if the click missed the point cloud (sky, globe, or another tileset):

​```ts
import { pickPoint } from 'copc-cesium';

handler.setInputAction((movement) => {
  const hit = pickPoint(tileset, viewer.scene, movement.position);
  if (hit) {
    // hit.cartographic → exact lon/lat/height · hit.attributes → per-point LAS values
    console.log(hit.cartographic, hit.attributes, hit.featureId);
  }
}, ScreenSpaceEventType.LEFT_CLICK);
​```
```
(주의: 위 펜스의 `​```` 앞 zero-width 문자는 plan 가독성용 — 실제 README 엔 일반 ```ts / ``` 펜스로 작성.)

- [ ] **Step 8: 커밋**

```bash
git add scripts/check-picking.ts src/picking.ts src/index.ts README.md
git commit -m "feat(#3): pickPoint — 클릭 점 위치+LAS 속성 조회 free 함수 (Cesium pick/pickPosition + #1)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: 데모 패널 + 브라우저 스모크

**Files:**
- Create: `demo/pick-panel.ts` (`installPickPanel`)
- Modify: `demo/main.ts` (import + `runDemo` 에서 호출)

**Interfaces:**
- Consumes: `pickPoint`, `PickedPoint` (Task 1). `installPickPanel(viewer: Viewer, tileset: Cesium3DTileset): void`.
- Produces: 없음 (데모 UI 종착).

- [ ] **Step 1: `demo/pick-panel.ts` 생성**

```ts
// 클릭 시 그 점의 경위도·고도 + LAS 속성을 우상단 패널에 표시. 빈 클릭(하늘/globe)은 숨김.
import { Math as CesiumMath, ScreenSpaceEventHandler, ScreenSpaceEventType } from 'cesium';
import type { Cartesian2, Cesium3DTileset, Viewer } from 'cesium';
import { pickPoint } from '../src/picking';

export function installPickPanel(viewer: Viewer, tileset: Cesium3DTileset): void {
  const panel = document.createElement('div');
  panel.id = 'pick-panel';
  panel.style.cssText =
    'position:absolute;top:8px;right:8px;padding:8px 10px;background:rgba(0,0,0,0.7);' +
    'color:#fff;font:12px/1.5 monospace;border-radius:4px;max-width:280px;display:none;white-space:pre;z-index:10;';
  document.body.appendChild(panel);

  const handler = new ScreenSpaceEventHandler(viewer.canvas);
  handler.setInputAction((movement: { position: Cartesian2 }) => {
    const hit = pickPoint(tileset, viewer.scene, movement.position);
    if (!hit) {
      panel.style.display = 'none';
      return;
    }
    const lines: string[] = [];
    if (hit.cartographic) {
      lines.push(
        `Lon ${CesiumMath.toDegrees(hit.cartographic.longitude).toFixed(5)}°`,
        `Lat ${CesiumMath.toDegrees(hit.cartographic.latitude).toFixed(5)}°`,
        `Height ${hit.cartographic.height.toFixed(1)} m`,
      );
    } else {
      lines.push('position: n/a');
    }
    for (const [k, v] of Object.entries(hit.attributes)) lines.push(`${k}: ${v}`);
    panel.textContent = lines.join('\n');
    panel.style.display = 'block';
  }, ScreenSpaceEventType.LEFT_CLICK);
}
```

- [ ] **Step 2: `demo/main.ts` 배선**

상단 import — 기존 `import { CopcTileset } from '../src/copc-tileset';` **뒤에** 추가:
```ts
import { installPickPanel } from './pick-panel';
```

`runDemo()` 안에서 `viewer.scene.primitives.add(tileset);` **바로 뒤에** 추가:
```ts
    installPickPanel(viewer, tileset);
```

- [ ] **Step 3: 타입체크 + 데모 빌드**

Run: `npm run build`
Expected: tsc 타입에러 0 (`demo/pick-panel.ts` 가 tsconfig include `demo` 로 strict 체크) + demo-dist 산출.

- [ ] **Step 4: 브라우저 스모크 (AC6)**

`npm run dev` 백그라운드 + Playwright MCP:
1. `http://localhost:5173/` 접속, 포인트클라우드 렌더 대기(~6s, `?` 없는 기본 데모).
2. 캔버스 중앙 클릭(autzen 밀집 → 점 히트) → `#pick-panel` 표시·`textContent` 에 `Lon -123` 포함·`Classification`/`Intensity` 행 존재.
3. 캔버스 좌상단 모서리 클릭(하늘 영역) → `#pick-panel` `display:none`.
4. 콘솔 `pageerror`/`console.error` 0.
Expected: 2·3·4 충족. 확인 후 dev 종료.
(주의: Playwright 는 swiftshader 소프트 GL — `scene.pick`/`pickPosition` 은 픽 프레임버퍼/depth 로 동작하므로 유효. 중앙 클릭이 점을 못 맞히면 캔버스 중앙 약간 아래(지면 밀집)로 재시도. 그래도 불안정하면 `browser_evaluate` 로 `window.__pickTest = pickPoint(...)` 직접 호출해 로직 확인 + 헤드리스 check-picking(하드 게이트)으로 충족 처리.)

- [ ] **Step 5: 커밋**

```bash
git add demo/pick-panel.ts demo/main.ts
git commit -m "feat(#3): 데모 점 피킹 패널 — 클릭→경위도·고도+속성 오버레이

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: 문서 + 최종 회귀 스윕

**Files:**
- Modify: `docs/CHANGELOG.md` (최상단 항목 추가)
- Modify: `docs/PROGRESS.md` (Tier1 #3-A 섹션, `## Phase 3` 앞)

**Interfaces:**
- Consumes: Task 1·2 결과.
- Produces: 없음.

- [ ] **Step 1: 전체 check 회귀 스윕 (AC5)**

Run:
```bash
npx tsx scripts/check-picking.ts && npx tsx scripts/check-ecef.ts && npx tsx scripts/check-attributes.ts && npx tsx scripts/check-coalesce.ts && npx tsx scripts/check-crs.ts && npx tsx scripts/check-style.ts
```
Expected: 전부 PASS (picking 신규 + 기존 5종 회귀 0).

- [ ] **Step 2: `docs/CHANGELOG.md` 항목 추가**

`### 2026-06-20` 섹션이 없으면 파일 최상단(`# CHANGELOG` 헤더 + 설명 줄 다음)에 `### 2026-06-20` 신설 후, 그 아래 추가. 있으면 그 섹션 최상단에 추가:
```
- [feat] **[IMPROVEMENTS Tier1 #3-A] 점 피킹 정보 조회 — `pickPoint(tileset, scene, windowPosition)` free 함수 + 데모 패널.** 점 클릭→그 점의 정확한 경위도·고도(Cesium `scene.pickPosition`) + LAS 속성(#1 batch table `getProperty`)을 한 호출로 조회. 소유권은 `picked.primitive===tileset`로 판정(globe 관통·하늘·타 tileset→undefined). **렌더러 손코딩 0**(Cesium 내장 pick/pickPosition만)·신규 의존성 0. `PickedPoint{position?,cartographic?,featureId,attributes}` export. 데모 `demo/pick-panel.ts`가 클릭→우상단 패널(경위도·고도+속성). 검증: `check-picking` 4케이스(소유→위치+속성·타 primitive/하늘→undefined·pickPosition 미지원→degraded) 결정적 헤드리스 + autzen 브라우저 스모크(Oregon 경위도+Classification/Intensity 실값) + verify C1·기존 check-* 회귀 0. 범위: 옵션 B(옥트리 최근접점·측정 스냅)=별도 사이클. (spec/plan `docs/superpowers/2026-06-20-point-picking-*`) (`src/picking.ts`+`index`+`demo/pick-panel`+`README`)
```

- [ ] **Step 3: `docs/PROGRESS.md` 섹션 추가**

`## Phase 3` 줄 **앞에** 삽입:
```
### Tier1 #3-A 점 피킹 정보 조회 (2026-06-20 · feat/point-picking)
- [x] **클릭→점 경위도·고도 + LAS 속성 조회.** `pickPoint()` free 함수(Cesium pick/pickPosition + #1 getProperty, 렌더러 손코딩 0) + 데모 패널. 소유권 `picked.primitive===tileset`(globe/하늘/타 tileset→undefined). check-picking 4케이스·autzen 브라우저 스모크·verify C1·기존 check-* 회귀 0. 범위 B(옥트리 최근접점·측정 스냅)=별도.

```

- [ ] **Step 4: 커밋**

```bash
git add docs/CHANGELOG.md docs/PROGRESS.md
git commit -m "docs(#3): 점 피킹(#3-A) CHANGELOG/PROGRESS 갱신

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review (작성자 점검 완료)

**1. Spec coverage:**
- AC1(소유→{position,cartographic,featureId,attributes}) → T1 Step1 case a ✓
- AC2(타 primitive/하늘→undefined) → T1 case b·c ✓
- AC3(pickPosition 미지원→degraded) → T1 case d ✓
- AC4(export·build:lib·.d.ts) → T1 Step5·6 ✓
- AC5(build·verify·기존 check-* 회귀) → T1 Step6 + T3 Step1 ✓
- AC6(브라우저 스모크) → T2 Step4 ✓
- 스펙 파일 구조(picking.ts·index·pick-panel·main·check-picking·README) 전부 매핑 ✓

**2. Placeholder scan:** README Step7의 zero-width 주석은 펜스 중첩 회피용 표기 설명(placeholder 아님). 모든 코드 스텝 verbatim. ✓

**3. Type consistency:** `pickPoint(tileset, scene, windowPosition)` 시그니처·`PickedPoint{position?,cartographic?,featureId,attributes}`·`installPickPanel(viewer, tileset)` 가 T1↔T2↔테스트 전부 동일. 소유권 `picked.primitive`·`scene.pickPositionSupported`·`getPropertyIds`/`getProperty`/`featureId` 는 context7로 확인한 Cesium API. ✓
