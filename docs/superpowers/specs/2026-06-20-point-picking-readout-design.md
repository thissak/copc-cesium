# 점 피킹 정보 조회 (Tier1 #3-A) — 설계 스펙

<!-- created: 2026-06-20 -->
<!-- topic: point-picking-readout -->

## 배경 / 목표

대회 헤드라인 강화 — "변환 없이 점을 있는 그대로 읽는다"를 **상호작용**으로 증명한다.
점을 클릭하면 그 점의 **정확한 경위도·고도 + LAS 속성**(#1로 노출한 batch table)을 보여준다.

IMPROVEMENTS #3(옥트리 피킹/스냅, stretch) 중 **저리스크 부분(A)만** 범위로 한다:
Cesium 내장 `scene.pick`/`pickPosition` + #1 `getProperty`를 조합한 클릭→정보 조회.
렌더러 손코딩 0(ADR-004 위임 규율 준수), 신규 의존성 0.

## 비목표 (Non-goals)

- **옵션 B(옥트리 최근접점 검색·측정 스냅)** — 진짜 hard·renderer-shaped, 별도 사이클. 이번 범위 밖.
- 하이라이트/셀렉션 스타일링(소비자가 `feature.color`로) · drill-pick(다중) · 측정 도구.
- 기존 라이브러리 로직 변경 — 없음(신규 파일 + index export + 데모만).

## API 설계

### `pickPoint` — free export 함수 (라이브러리)

`rampStyle` 선례처럼 **free 함수로 export**(duck-typed 메서드 아님 → 완전 타입·테스트 용이).

```ts
// src/picking.ts
import { Cartesian3, Cartographic, Cesium3DTileFeature } from 'cesium';
import type { Cesium3DTileset, Scene, Cartesian2 } from 'cesium';

export interface PickedPoint {
  position?: Cartesian3;        // ECEF (scene.pickPosition; 미지원/실패 시 undefined)
  cartographic?: Cartographic;  // lon/lat(rad)·height(m) (position 에서 파생)
  featureId: number;            // BATCH_ID (Cesium3DTileFeature.featureId)
  attributes: Record<string, number | string>;  // 노출된 LAS 속성(우리 점이면 항상 존재)
}

/**
 * windowPosition 의 점이 주어진 copc tileset 소유면 그 점의 위치+속성을, 아니면 undefined.
 * globe 관통·하늘·타 tileset 은 undefined 로 걸러진다.
 */
export function pickPoint(
  tileset: Cesium3DTileset,
  scene: Scene,
  windowPosition: Cartesian2,
): PickedPoint | undefined;
```

`index.ts` 에서 `pickPoint`, `PickedPoint` export.

### 로직 (전부 Cesium 내장)

1. `const picked = scene.pick(windowPosition);`
2. **소유권**: `if (!picked || picked.primitive !== tileset) return undefined;`
   (`Cesium3DTileFeature.primitive` = 소유 tileset. 참조 동일성으로 우리 것만 통과 — globe/타 tileset 거름.)
3. **위치**: `const position = scene.pickPositionSupported ? scene.pickPosition(windowPosition) : undefined;`
   `const cartographic = position ? Cartographic.fromCartesian(position) : undefined;`
   (pickPosition 미지원/undefined·지구중심 퇴화 시 위치 필드 undefined — throw 없음.)
4. **속성**: `for (const id of picked.getPropertyIds()) attributes[id] = picked.getProperty(id);`
   (#1 의 `attributes` 옵션을 자연 반영 — 기본 큐레이션 4종.)
5. `return { position, cartographic, featureId: picked.featureId, attributes };`

## 데모 패널

`demo/pick-panel.ts`(신규, ~40줄): `installPickPanel(viewer, tileset)` — LEFT_CLICK 핸들러 등록 +
오버레이 div 생성. `runDemo`(`demo/main.ts`)가 tileset 생성 후 1회 호출.

- 클릭 → `pickPoint(tileset, viewer.scene, movement.position)`
  - 결과 있으면: "Lon X.xxxxx° · Lat Y.xxxxx° · Height Z.x m" + 속성 행(`name: value`) 표시.
  - `undefined`(빈 클릭/globe): 패널 숨김.
- 스타일: 기존 데모 HUD(`log()` 오버레이) 톤 매칭(우상단 고정·반투명·monospace).

## 에러 처리 ([[no-silent-failures]])

| 상황 | 동작 |
|------|------|
| 하늘 클릭(`scene.pick` undefined) | `pickPoint` → undefined → 패널 숨김 |
| globe/타 tileset(소유권 실패) | undefined → 패널 숨김 |
| 우리 feature·pickPosition 미지원/실패 | `{position:undefined, cartographic:undefined, featureId, attributes}` — 속성은 표시, 위치는 "n/a"(조용한 실패 아님) |
| 속성 미노출(`attributes:[]`) | `attributes:{}` + 위치 표시 |

## 파일 구조

| 파일 | 액션 | 책임 |
|------|------|------|
| `src/picking.ts` | 신규 (~30줄) | `pickPoint` + `PickedPoint`. 페이지측(Cesium import 허용, `copc-style.ts` 와 동일 레이어) |
| `src/index.ts` | 수정 | `pickPoint`·`PickedPoint` export 추가 |
| `demo/pick-panel.ts` | 신규 (~40줄) | `installPickPanel(viewer, tileset)` — 클릭 핸들러 + 패널 DOM |
| `demo/main.ts` | 수정 | `runDemo` 에서 `installPickPanel` 1회 호출 |
| `scripts/check-picking.ts` | 신규 | 헤드리스 결정적 테스트(fake scene/feature) |
| `README.md` | 수정 | "Style & pick" 섹션에 `pickPoint` 사용 추가 |

`tsup` 엔트리(`src/index.ts`)가 `picking.ts` 를 번들 → `dist` 에 포함(cesium externalize 유지).

## 검증 기준 (Acceptance Criteria)

- [ ] **AC1**: `pickPoint` 가 소유 feature 에 `{position, cartographic, featureId, attributes}` 반환 — `cartographic.longitude/latitude` 가 입력 위치와 일치, `attributes` 가 fake getProperty 값과 일치 (check-picking case a).
- [ ] **AC2**: `picked.primitive !== tileset`(globe/타 tileset) 와 `scene.pick`===undefined(하늘) 둘 다 `undefined` 반환 (cases b·c).
- [ ] **AC3**: `scene.pickPositionSupported===false` 시 `position`/`cartographic` undefined·`attributes` 존재·throw 0 (case d).
- [ ] **AC4**: `pickPoint`·`PickedPoint` 가 `index.ts` 에서 export, `npm run build:lib` 통과·`dist/index.d.ts` 에 `pickPoint` 시그니처 존재.
- [ ] **AC5**: `npm run build`(tsc+vite) GREEN, `npm run verify` C1 Oregon PASS, 기존 `check-*`(ecef/coalesce/attributes/crs/style) 회귀 0.
- [ ] **AC6**: 브라우저 스모크(autzen) — 렌더된 점 클릭 시 패널에 lon≈-123°·lat≈44°·height + Classification/Intensity 실값 표시, 하늘 클릭 시 패널 숨김, 콘솔 에러 0.

## 테스트 시나리오

- **정상(헤드리스)**: fake `tileset={}`, fake scene(`pick`→fakeFeature{primitive:tileset, featureId:7, getPropertyIds:['Classification','Intensity'], getProperty}, `pickPositionSupported:true`, `pickPosition`→`Cartesian3.fromDegrees(-123.07,44.06,100)`) → `pickPoint` 결과 cartographic≈(-123.07,44.06,100)·attributes{Classification:5,Intensity:5120}·featureId:7. (Cesium 수학은 실제 사용, scene/feature 만 fake — check-ecef.ts 선례.)
- **엣지(헤드리스)**: pick→`{primitive:{}}`(타 primitive)→undefined; pick→undefined(하늘)→undefined; `pickPositionSupported:false`→position undefined·attributes 존재.
- **실패(헤드리스)**: `getProperty` 가 throw 하면 표면화(라이브러리는 삼키지 않음 — 호출자 try/catch 책임). 단 `pickPosition`===undefined 는 정상 degraded(undefined 위치).
- **통합(브라우저)**: AC6.

## 롤백

신규 파일 2개 + index export 1줄 + 데모 1줄 호출 → `git revert` 가역. 기존 라이브러리 로직 무변경이라 회귀면 verify/check-* 즉시 적발.
