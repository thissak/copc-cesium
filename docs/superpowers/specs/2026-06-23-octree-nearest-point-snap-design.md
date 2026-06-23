# 옥트리 풀해상도 최근접점 스냅 (Tier1 #3-B) — 설계 스펙

<!-- created: 2026-06-23 -->
<!-- topic: octree-nearest-point-snap -->

## 배경 / 목표

대회 헤드라인 심화 — #3-A(클릭→점 정보 조회, 출하됨 PR#7)의 한계를 COPC **옥트리(공간 인덱스)**로 돌파한다.
`scene.pickPosition`은 *화면에 렌더된 픽셀의 깊이*라 (1) 점 사이 빈틈/배경 클릭 시 실패, (2) 현재 렌더 LOD에 묶임, (3) depth 역산 위치(저장 점의 정확 좌표 아님)다.

#3-B는 클릭 지점에서 **풀해상도 옥트리의 실제 최근접 점**을 찾아 그 점의 *정확 좌표 + 속성*을 반환한다.
**구조적 moat**: COPC 옥트리는 공간 인덱스라 임의 위치의 가장 깊은 노드를 온디맨드 디코드해 풀해상도 점을 질의할 수 있다 — `.pnts`로 변환한 엔진은 이 인덱스가 없어 못 한다("변환 안 해서 측량까지 정확").

렌더러 손코딩 0(ADR-001/ADR-004 위임 규율 준수), 신규 의존성 0.

## 범위 결정 (brainstorming 합의)

- **핵심 산출물 = 옥트리 정확 최근접점 스냅**(측정 도구 아님 — 측정은 별도 사이클).
- **풀 해상도** = 클릭 위치의 *가장 깊은 실재 노드*를 fetch+decode(클릭당 ~1노드, occasional이라 지연 수용). "로드된 점만"과 구현 비용 거의 동일한데 moat 완전.
- **씨앗점 기준 (MVP)** = `pickPosition`이 준 3D 씨앗에 최근접인 실제 점. splat 맞는 클릭(절대다수, EDL/atten으로 splat 큼)은 전부 커버.

## 비목표 (Non-goals)

- **광선 기준 / 진짜 빈틈(splat 전무) 클릭** — 옥트리 ray-AABB 순회 필요. MVP는 씨앗 실패 시 `undefined`. (후속 확장 여지로 문서화)
- **측정 도구**(점-점 거리·폴리라인·면적)·**하이라이트/스냅 마커 시각화** — 별도 사이클. 스냅은 *질의*만.
- **다중 LOD union / 이웃 노드 검색** — 가장 깊은 노드 1개만(그 자리 최고밀도). 노드 경로 union·인접 노드 검색 안 함.
  ⚠️ **한계(PR#21 R2 실측)**: 따라서 노드 경계에 붙은 클릭은 진짜 전역 최근접 점이 인접 노드에 있어 ~노드 spacing
  (autzen 최대 ~0.14m)만큼 빗날 수 있다. = "로컬 풀해상도 근사 스냅"(전역 최근접 보장 아님). 이웃 검색=후속 enhancement.
  README/JSDoc 에 동일 caveat 명시. (즉 §배경의 "정확 최근접점"은 *로컬 노드 내 정확*으로 읽는다 — over-headline 금지.)
- 기존 라이브러리 렌더/스트리밍 로직 변경 — 없음.

## 아키텍처 & 데이터 흐름 (Cesium-free 경계 유지)

```
page  (copc-tileset.ts: tileset.snapPoint)         ← Cesium 은 여기서만
  picked = scene.pick(win); 소유권 가드(primitive===tileset)
  seed = scene.pickPosition(win) → Cartographic(lon°, lat°, h m)   (실패 시 undefined 반환)
        │  worker.nearestPoint(sid, {lon, lat, height})
        ▼
worker (decode.worker.ts: nearestPoint(sid, seed))
  source XYZ = [ toWgs.inverse([lon,lat]) , height / zUnit ]       (역reproject, 1점)
  key  = copc-core.locateDeepestNode(session, sx, sy, sz)          (키패스 하강, 필요시 loadSubPage)
  hit  = copc-core.nearestPointInNode(session, key, seed, attrSpecs, lazPerf)
        ▼  { lon, lat, height, attributes }   (승자 1점만 reproject + 속성 읽기)
page: ECEF position = Cartesian3.fromDegrees(lon,lat,height); distanceM = ECEF 거리(seed↔hit)
        ▼  SnappedPoint | undefined
```

- **순수 로직**(노드 위치·최근접 math)은 `copc-core`(Cesium-free, Node에서 테스트), **디코드**는 워커 재사용(`loadPointDataView`+laz-perf), **Cesium**(pick/pickPosition/ECEF)은 page 메서드에만.
- **렌더러 손코딩 0** — 스냅=데이터 쿼리. IMPROVEMENTS의 "renderer-shaped 리스크"는 이 범위(시각화 제외)에선 발생 안 함.
- **효율**: 노드 점 비교는 **source CRS 공간**에서(전체 reproject 안 함), 승자 1점만 reproject. 클릭당 노드 1개 디코드(coalescing 캐시 적중 시 빠름).

## 좌표 / 노드 위치 로직 (핵심 디테일)

- **씨앗 역변환**: `pickPosition`(ECEF) → `Cartographic`(lon rad, lat rad, h m). 워커엔 도(°)+m로 전달. 워커에서 수평 `toWgs.inverse([lon°,lat°]) → [sx, sy]`(source CRS), 수직 `sz = h / zUnit`(source Z 단위). `toWgs`는 `session`의 raw proj4(forward+inverse 보유 — `reproj` 격자는 forward 전용이라 씨앗 역변환엔 raw proj4 사용; `Reproj` 타입에 `inverse?` 추가).
- **가장 깊은 노드**(`locateDeepestNode`): 루트 `0-0-0-0`부터 하강. 깊이 d의 한 변 `side = (cube[3]-cube[0]) / 2^d`(큐브), 인덱스 `x=floor((sx-cube[0])/side_{d+1})`, y·z 동일 → 자식 키 `${d+1}-${x}-${y}-${z}`(tileset.ts childKeys 규약). `session.nodes[key]` 있으면 더 하강; `session.pages[key]`(미로드)면 `loadSubPage` 후 재시도; 둘 다 없으면 직전(가장 깊은 실재) 노드 채택. 씨앗이 큐브 밖이면(클램프) → 루트.
- **노드 내 최근접**(`nearestPointInNode`): `Copc.loadPointDataView` → `getter('X'|'Y'|'Z')` 루프, `d2 = (gx-sx)² + (gy-sy)² + (gz-sz)²` 최소 인덱스(squared, source 공간 — X·Y·Z 동일 선형단위라 *등방*, 어느 축도 zUnit 미적용). `dist`는 `√d2·zUnit`(미터). ⚠️ **PR#21 R2 정정**: 옛 안 `((gz-sz)·zUnit)²`는 dz 에만 zUnit → 피트 CRS(autzen)서 수평 1/zUnit²≈10.76× 과대 → 오답. 승자 `(gx,gy)` → `reproj.forward` → lon,lat; height `gz·zUnit`. 속성은 `attrSpecs` getter를 승자 인덱스에서 읽음(decodeNode `attrValues`와 동일 규약). `hideClassifications` 점은 스킵(렌더와 일관). 0점/전부 스킵 → null.
- **거리 보고**: 선택은 source 공간(싸게), 반환 `distanceM`은 page에서 ECEF(seed↔hit) 정확 미터.

## API

```ts
// src/picking.ts (page 레이어 — 단, 워커/세션 접근 필요해 tileset 메서드로 노출)
export interface SnappedPoint {
  position: Cartesian3;          // ECEF (승자 점, 정확 reproject)
  cartographic: Cartographic;    // lon/lat(rad)·height(m)
  attributes: Record<string, number | string>;  // 노출된 LAS 속성(없으면 {})
  distanceM: number;             // 씨앗(pickPosition)↔승자 ECEF 거리(m) — 스냅 이동량
}
```

- `tileset.snapPoint(scene, windowPosition): Promise<SnappedPoint | undefined>`
  — 메서드로 노출(`attributeRange`/`copcProfile`/`copcNodeCount` 선례). 워커+세션 접근 필요해 free 함수 부적합. `copc-tileset.ts`의 `fromUrl` 클로저에서 sid·`pageSessions`·`getWorkerApi` 사용.
- `copc-core` (순수, export): `locateDeepestNode(session, sx, sy, sz): Promise<string | undefined>`, `nearestPointInNode(session, key, seed, attrs, lazPerf): Promise<{lon,lat,height,attributes} | null>`.
- `decode.worker.ts`: `nearestPoint(sid, seed): Promise<{lon,lat,height,attributes} | null>` (역변환→locate→nearest, attrSpecs 미해결 시 decode와 동일하게 해결).
- 데모 `demo/pick-panel.ts`: 기존 클릭 패널에 스냅 결과(좌표·속성·`distanceM`) 표시(#3-A 패널 확장 또는 토글).

## 에러 처리 ([[no-silent-failures]])

| 상황 | 동작 |
|------|------|
| `pickPosition` 미지원/실패(빈틈·하늘) | `snapPoint` → `undefined`(명시적 부재, throw 없음) |
| 소유권 실패(globe/타 tileset) | `undefined` (scene.pick.primitive!==tileset 가드) |
| 씨앗 큐브 밖·역변환 NaN | `undefined`(경고 1회) — 잘못된 좌표 표면화 |
| 노드 경로 끝(실재 노드 없음)·디코드 0점·전부 hide | `undefined` |
| 워커/디코드 예외(비-마지막 tileset destroy 등)·worker terminate hang | `console.warn` + `undefined` (계약 유지; 40s 백스톱 타임아웃 + query `.catch`, PR#21 R2 — reject 미전파해 소비자 미처리 rejection 방지) |

## 파일 구조

| 파일 | 액션 | 책임 |
|------|------|------|
| `src/copc-core.ts` | 수정 | `locateDeepestNode`·`nearestPointInNode` 신설(순수), `Reproj`에 `inverse?` 추가 |
| `src/decode.worker.ts` | 수정 | `nearestPoint(sid, seed)` api 추가(역변환·locate·nearest, attrSpecs 재사용) |
| `src/copc-tileset.ts` | 수정 | `tileset.snapPoint(scene, win)` 메서드(pickPosition 씨앗 + 워커 호출 + ECEF distance) |
| `src/picking.ts` | 수정 | `SnappedPoint` 인터페이스 export(픽킹 레이어 동거) |
| `src/index.ts` | 수정 | `SnappedPoint` export |
| `demo/pick-panel.ts` | 수정 | 스냅 결과 표시(좌표·속성·distanceM) |
| `scripts/check-snap.ts` | 신규 | 헤드리스 결정적 테스트(실 autzen 노드 + 알려진 씨앗) |
| `README.md` | 수정 | snapPoint 사용 추가 |

## 검증 기준 (Acceptance Criteria)

- [ ] **AC1**: 알려진 씨앗(autzen 루트 근처 실좌표)으로 `nearestPointInNode`가 반환한 점이 **그 노드 점 중 씨앗에 최소거리**임을 brute-force 대조로 확인(check-snap), 반환 좌표가 그 점의 reproject와 일치(sub-mm).
- [ ] **AC2**: `locateDeepestNode`가 씨앗 위치의 *가장 깊은 실재* 노드 키 반환 — autzen에서 더 깊은 노드 존재 시 그것을, 큐브 밖 씨앗은 `undefined`/루트, 미로드 서브페이지는 loadSubPage 후 도달(millsite/sofi 깊은 노드 1케이스).
- [ ] **AC3**: `snapPoint`가 씨앗 없음(pickPosition 미지원)·소유권 실패·역변환 NaN에서 `undefined` 반환·throw 0(check-snap fake scene 케이스).
- [ ] **AC4**: `distanceM`이 씨앗↔승자 ECEF 거리와 일치(±1mm), 속성이 승자 점의 LAS 값과 일치(Classification 등).
- [ ] **AC5**: `SnappedPoint` export·`npm run build:lib` 통과·`dist/index.d.ts`에 타입 존재. `tsup`이 변경 파일 번들(cesium externalize 유지).
- [ ] **AC6**: 회귀 0 — `npm run build`(tsc+vite) GREEN, `npm run verify` C1 Oregon PASS, 기존 `check-*`(ecef/coalesce/paging/picking/attributes/crs/style) GREEN. 골든 렌더 불변.
- [ ] **AC7**: 브라우저 스모크(autzen) — 점 클릭 시 패널에 스냅점 lon≈-123°·lat≈44°·height + Classification/Intensity 실값 + distanceM(작은 값) 표시, 빈틈/하늘 클릭 시 패널 숨김, 콘솔 에러 0.

## 테스트 시나리오

- **정상(헤드리스, check-snap)**: 실 autzen COPC 열기 → 루트 노드의 한 점 좌표를 씨앗으로(미세 오프셋) → `nearestPoint`가 그 점(또는 더 가까운 점) 반환, brute-force min과 일치. `locateDeepestNode`가 그 좌표의 가장 깊은 노드 반환.
- **엣지(헤드리스)**: 씨앗=큐브 밖 → undefined/루트; 미로드 서브페이지 깊은 좌표(millsite) → loadSubPage 후 노드 도달; 노드 전부 hideClassifications → null.
- **실패(헤드리스, fake scene)**: `pickPositionSupported:false` → undefined; `scene.pick.primitive`≠tileset → undefined; 역변환 NaN(garbage 씨앗) → undefined+warn.
- **통합(브라우저)**: AC7.

## 롤백

`copc-core`/`worker`/`copc-tileset` 추가는 신규 함수·메서드(기존 경로 무변경) → 회귀면 verify/check-* 즉시 적발. 데모/README/index는 가역. `git revert` 안전(렌더 파이프라인·골든파일 무변경).
