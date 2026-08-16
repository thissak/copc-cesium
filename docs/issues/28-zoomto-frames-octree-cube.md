# #28 zoomTo 초기 시점이 점군이 아닌 옥트리 큐브를 프레이밍한다

**Issue**: (로컬 문서 전용 — 공개 repo GH 이슈 미등록)
**Status**: Resolved (후보 — `/issue-track close #28` 대기)
**Created**: 2026-08-16
**Resolved**: 2026-08-16

---

## 1. 문제

### 증상
- `CopcTileset.fromUrl()` 결과에 `viewer.zoomTo(tileset)` 를 하면 점군이 화면 **중앙이 아니라 아래쪽**에 치우쳐 잡힌다.
- 화면 상단 대부분이 빈 배경으로 남아, 점군이 실제보다 작고 구석에 몰린 것처럼 보인다.
- 데모 기본 경로(`runDemo`)가 `await viewer.zoomTo(tileset)` 를 쓰므로 **플러그인을 처음 켠 사용자가 바로 겪는다.**

### 재현 조건
- 환경: Windows 11, Chromium 149 (Playwright 1228), NVIDIA RTX 4090 / ANGLE D3D11, 1920×1080
- 단계:
  1. `npm run dev`
  2. `http://localhost:5173/?ds=autzen` (기본 경로 = `CopcTileset.fromUrl` 데모)
  3. 로드 완료 후 초기 화면 확인

### 스크린샷 / 로그
- 초기 화면: 점군이 하단 1/3 에만 존재. (재현 캡처 = 세션 스크래치 `smoke-rgb.png`)

---

## 2. 원인 분석

### 측정 데이터

Autzen(`autzen-classified.copc.laz`) 로드 후 실측:

| 대상 | 중심 고도(h) | 반경 |
|------|-------------|------|
| `tileset.boundingSphere` (zoomTo 가 쓰는 값) | **833.3 m** | 1254.7 m |
| 실제 로드된 타일 13개 중심 분포 | min 212.5 / mean 376.2 / max 833.3 m | mean 446.3 m |
| 화면 그리드 pick 으로 잡은 **보이는 점군** 중심 | **134 ~ 156 m** | — |

Autzen(미 오리건 유진) 실제 지반고가 약 130 m 이므로, 점군은 h≈134 m 에 있는데 조준점은 **약 700 m 위**에 잡힌다.

### 근본 원인

COPC 옥트리 노드는 **정육면체**다. `copc.info.cube` 의 한 변은 데이터의 가장 긴 수평 범위(Autzen ≈ 2.5 km)와 같으므로, Z 축도 그만큼 위로 뻗는다. 점은 그 큐브의 **바닥 얇은 층**에만 존재한다.

- `src/tileset.ts` 의 region 계산은 ADR-007 R14 정책에 따라 **projected 타일 Z 를 항상 node cube Z 로** 쓴다. 이건 OGC 3D Tiles 의 "content 완전포함" 계약상 **정상이며 바꾸면 안 된다.**
- Cesium 의 `Cesium3DTileset.boundingSphere` 는 root 타일 boundingVolume 에서 파생되므로, 그대로 **큐브의 구**가 된다.
- `viewer.zoomTo(tileset)` 는 그 구의 중심을 조준한다 → 점군보다 한참 위를 본다.

즉 **타일 경계는 옳고, 카메라 조준용 구가 없는 것**이 문제다. 플러그인은 `copc.header.min` / `copc.header.max` (실제 점 범위)를 이미 파싱해 보유하고 있다(`src/copc-core.ts`, `src/tileset.ts`).

### 기각한 우회안
- **녹화 스크립트에서 화면 grid `scene.pickPosition` 으로 조준점 추정** — `pickPosition` 이 창 좌표와 무관하게 **동일 좌표를 반환**해 반경 추정이 항상 0 이 됐다(측정으로 확인). 조준 중심만은 맞았으나 거리 산출 근거로 쓸 수 없고, 애초에 데모/사용자 문제를 남긴다.
- **root 타일 boundingVolume 을 header 범위로 축소** — ADR-007 R14 의 완전포함 계약 위반. 컬링 오류를 만든다.

---

## 3. Best Practice 조사

### 조사 항목
- Cesium 공식 레퍼런스(context7 `/websites/cesium_learn_cesiumjs_ref-doc`)에서 ① `Cesium3DTileset.boundingSphere` 의 정의와 가변 여부, ② 타일 경계를 건드리지 않고 초기 시점만 교정하는 공식 경로, ③ region(min/max 높이) → 구 변환의 표준 방법.

### 프로덕션 사례
| 프로젝트 | 접근 방식 | 비고 |
|---------|----------|------|
| CesiumJS `Cesium3DTileset` | `boundingSphere` 는 **readonly**, root 타일 boundingVolume 에서 파생 | [ref-doc/Cesium3DTileset](https://cesium.com/learn/cesiumjs/ref-doc/Cesium3DTileset.html) — 경계를 바꾸지 않고는 이 값을 못 바꾼다 |
| CesiumJS `Camera` | `flyToBoundingSphere(boundingSphere, options)` / `viewBoundingSphere(sphere, offset)` 는 **월드좌표의 임의 BoundingSphere** 를 받는다. offset 은 구 중심의 local ENU 기준 heading/pitch/range | [ref-doc/Camera](https://cesium.com/learn/cesiumjs/ref-doc/Camera.html) — "The boundingSphere to view, **in world coordinates**" |
| CesiumJS `Viewer.zoomTo` | 대상이 tileset 이면 그 `boundingSphere` 를 쓰지만, **BoundingSphere 를 직접 넘길 수도 있다** | [ref-doc/Viewer](https://cesium.com/learn/cesiumjs/ref-doc/Viewer.html) |
| CesiumJS region boundingVolume 내부 처리 | region(min/max 높이) → `OrientedBoundingBox.fromRectangle` → `BoundingSphere.fromOrientedBoundingBox` | 최소·최대 높이를 함께 반영하는 표준 경로. `BoundingSphere.fromRectangle3D` 는 **단일 surfaceHeight** 만 받아 부적합 |

**결론**: 공식 API 는 "조준용 구"를 tileset 경계와 분리하는 것을 이미 허용한다. 따라서 **타일 boundingVolume 은 ADR-007 R14 그대로 두고, 실제 점 범위로 만든 구를 별도 노출해 Cesium 표준 프레이밍 API 에 넘긴다**가 규격에 부합하는 해법이다.

### 엣지 케이스 / 위험 요소
| 시나리오 | 위험도 | 대응 |
|---------|--------|------|
| geographic CRS (도 단위 XY + m 단위 Z) | 높 | header 범위를 그대로 쓰면 축 단위가 섞인다. ADR-007 의 축별 metric 계약을 따라야 함 |
| 손상된 header (퇴화 bbox / Z 비정상) | 중 | 이슈 #23 계약대로 유효성 판정 후 cube 폴백 |
| 수직형 스캔(벽면·건물) | 중 | 점 범위가 세로로 길 때 반경 산출이 과소되지 않아야 함 |

---

## 4. 수정 내용

### 변경 파일
| 파일 | 변경 요약 |
|------|----------|
| `src/tileset.ts` | `pointExtentRegion(s)` 추가 — LAS header 실제 점 범위를 WGS84 region 으로. header 불신 시 `null` |
| `src/copc-tileset.ts` | `copcPointBoundingSphere` 를 공개 타입에 추가하고 `fromUrl` 에서 계산·부착. 실패 시 큐브 구로 폴백 |
| `demo/main.ts` | 초기 시점을 `zoomTo(tileset)` → `flyToBoundingSphere(tileset.copcPointBoundingSphere)` 로 |
| `scripts/bench/repro-28.ts` | 재현·검증 스크립트 (신규) |

**타일 boundingVolume 은 건드리지 않았다** — ADR-007 R14 의 완전포함 계약 유지.

### Before / After
```typescript
// Before — demo/main.ts : 옥트리 큐브 구를 조준
await viewer.zoomTo(tileset);

// After — 실제 점 범위 구를 조준
await viewer.camera.flyToBoundingSphere(tileset.copcPointBoundingSphere, { duration: 0 });
```

```typescript
// After — src/copc-tileset.ts : region(min/max 높이) → 구. Cesium 이 region 경계에 쓰는 경로와 동일.
const extent = pointExtentRegion(session);
aimSphere = BoundingSphere.fromOrientedBoundingBox(
  OrientedBoundingBox.fromRectangle(
    new Rectangle(extent.west, extent.south, extent.east, extent.north),
    extent.minH, extent.maxH, Ellipsoid.WGS84,
  ),
);
```

### PR
(브랜치 `fix/28-zoomto-frames-octree-cube` — 미생성)

---

## 5. 검증 결과

### 테스트 방법
`scripts/bench/repro-28.ts` — dev 서버 기동 후 `tsx scripts/bench/repro-28.ts [ds]`.

지구본·하늘·태양을 끄고 캔버스 위 DOM 오버레이(HUD·툴바·도움말·크레딧)를 숨긴 뒤 캔버스를 캡처하면
**남는 비검정 픽셀 = 점군**이다. 그 픽셀들의 화면좌표 중심 `cy` 가 뷰포트 중앙(0.5)에서 얼마나 벗어나는지로 판정한다.
- 합격: `|cy − 0.5| ≤ 0.12` **그리고** 화면 점유율 ≥ 4%

> 기각한 계측: `scene.pickPosition` 그리드 샘플링 — 창 좌표와 무관하게 동일 좌표를 반환해(측정 확인) 반경 추정이 항상 0 이 됐다.

### 결과

| 항목 | 수정 전 | 수정 후 | 판정 |
|------|---------|---------|------|
| Autzen — 점군 화면중심 `cy` | 0.8441 | **0.5690** | PASS |
| Autzen — 중앙 이탈 `\|cy−0.5\|` | 0.3441 (허용 0.12) | **0.0690** | PASS |
| Autzen — 화면 점유율 | 13.91% | **18.33%** | PASS |
| SoFi Stadium(1.9GB) — 중앙 이탈 | — | **0.0496** | PASS |
| SoFi Stadium — 화면 점유율 | — | 15.71% | PASS |
| 오프라인 체크 9종 | 9/9 | **9/9** | 회귀 없음 |
| `tsc --noEmit` | 통과 | 통과 | 회귀 없음 |

참고: `tileset.boundingSphere`(중심고도 833.3 m, 반경 1254.7 m)는 **의도적으로 그대로**다 — 타일 완전포함 계약 유지.

### 잔여 이슈
- `npm test`(집계 러너 `scripts/run-checks.ts`)가 Windows 에서 0/9 로 나온다. 개별 체크는 9/9 통과하므로
  러너의 `spawnSync('npx', …)` 가 Windows 에서 실패하는 별건이다. **본 이슈 수정 전에도 동일하게 재현**되어
  이 이슈의 회귀가 아니다. → 별도 이슈로 등록.
