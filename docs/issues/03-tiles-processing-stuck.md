# #03 numberOfTilesProcessing 영구 고착 — settle 후에도 0으로 안 빠짐

Status: Resolved (후보) · Label: bug · Branch: worktree-eptium-bench
발견 경로: 이슈 #02 잔여 + handoff task #1(벤치 settle 메트릭 수정) 중 측정으로 분리됨.
재현 하니스: `scripts/bench/repro-03.ts` + `scripts/bench/diag-settle.ts` (probe `inspectTiles`/`watchTilesLoaded`).

## 1. 문제 (재현 — RED 확인)

millsite msse=8 anchor 후 뷰가 완성(pending=0, tilesReady=44 안정, ~14.6s)된 뒤 **8초를 더 기다려도**:

```
tilesLoaded             = false
allTilesLoadedFired     = false
initialTilesLoadedFired = false
numberOfTilesProcessing = 13  (pending=0, tilesReady=44)
content state 분포        = {UNLOADED:3531, PROCESSING:13, READY:44}  (총 3588)
```

고착 13개 = 전부 **depth=3 `.pnts`(`Model3DTileContent`), `pointsLength:0`, `modelReady:false`, state=PROCESSING(2)**.
즉 콘텐츠는 도착(pending=0)했으나 **0점 → Model 이 PROCESSING→READY 전이도 FAILED 도 안 됨(림보)**.

**영향(가설 A 확정):** `numberOfTilesProcessing`이 영영 0이 안 되므로 Cesium `tileset.tilesLoaded`가 **영영 false**,
`allTilesLoaded`/`initialTilesLoaded` 이벤트가 **영영 fire 안 함**. 우리 결과물은 "Cesium provider 플러그인"(ADR-001)이라,
소비자가 `allTilesLoaded`로 "로드 완료"를 기다리면 **무한 대기**([[no-silent-failures]] 위반). 가시 렌더 결과 자체는 정상(뷰 완성).

재현: `tsx scripts/bench/repro-03.ts millsite 8` → `[REPRO #03] RED 확인 ✓`.

## 2. 원인 분석 (근본, 코드 확인)

전부 노이즈 classification(ASPRS 7·18, 기본 `hideClassifications`)인 노드가 **0점으로 디코드되는데도 빈 pnts 가 서빙**된다.

1. `src/copc-core.ts:243-258` `decodeNode` — `hideClass` 매치 점을 전부 skip. 노드의 모든 점이 노이즈면
   `keep.length===0` → **non-null 0점 노드 반환**(`{lonLatH:[], count:0}`). (missing 노드만 null)
2. `src/decode.worker.ts:39-42` `decode` — `nd`가 non-null이면 무조건 `buildQuantizedPnts` 호출.
3. `src/pnts-quantized.ts:52,79` `buildQuantizedPnts` — `n===0`을 가드만 하고 **유효한 빈 pnts(POINTS_LENGTH:0)** 생성.
4. `src/copc-tileset.ts:106-108` 핸들러 — 빈 pnts(non-null ArrayBuffer)라 `if(!pnts)` 통과 → Cesium 에 전달.
5. Cesium 1.142 는 `.pnts`를 `Model3DTileContent`로 로드 → **0점 Model 은 `ready` 도달 못 함** → PROCESSING 영구.

측정으로 13개 전부 `pointsLength:0`·`modelReady:false` 확인(§1). depth=3 한 밴드에 몰린 = 그 영역이 전부 노이즈.

## 3. Best Practice 조사 (Cesium 소스 = ground truth, 1.142)

빈 노드를 Cesium 이 "빈 타일(ready·에러 없음)"로 처리하게 만드는 정식 경로를 설치된 Cesium 빌드에서 확인.

| 후보 | 결과 | 출처 |
|------|------|------|
| 빈 pnts(POINTS_LENGTH:0) 서빙 | Model PROCESSING 고착 (현 버그) | 측정 §1 |
| HTTP 204 | `fetchArrayBuffer`가 `resolve(undefined)`(success) → `makeContent(undefined)` → `preprocess` throw → **FAILED** | `Cesium.js` 24228, 151841 |
| HTTP 200 빈 바디 | `preprocess` "Invalid tile content" throw → **FAILED** | 151841 |
| HTTP 404 (error) **+ `missingTilePolicy`** | xhr reject(`RequestErrorEvent(404)`) → `isEmptyTile(404∈policy)` → **`Empty3DTileContent`·ready·에러 없음** | 24203, 155284, 155365 |

→ **채택: Cesium 의 `missingTilePolicy` 메커니즘** — Cesium 자체가 MVT 벡터 프로바이더의 빈 타일에 쓰는 그것(`Cesium.js:260726` `missingTilePolicy:{statusCodes:[404,204]}`). 빈 노드를 404 로 서빙하고 tileset 에 `_runtimeContentCodec = { missingTilePolicy: { statusCodes: [404] } }` 를 단다. `createContent`를 **주지 않으므로** 일반 pnts(200) 경로는 `makeContent`의 `typeof createContent==='function'` 체크에서 무영향(`Cesium.js:155383`).

**엣지/위험:**
| 위험 | 대응 |
|------|------|
| `_runtimeContentCodec` 는 private(`_`) API → Cesium 업그레이드 시 변동 | `repro-03.ts`가 회귀 테스트. 방어적 read(`?._runtimeContentCodec?.missingTilePolicy`)라 제거돼도 크래시 아님(고착 재발→테스트가 잡음). peer dep `>=1.120`·핀 1.142 명시. |
| 404 가 진짜 누락과 충돌 | 404=빈 노드 전용. 진짜 누락 노드는 worker `throw`→handler `{error}`→**500**(FAILED 표면화). range fetch 에러는 worker 내부(별 레이어). |
| 빈 부모 노드의 자식 refine | `Empty3DTileContent`(hasRenderableContent=false)는 refine-투명 → 자식 정상 스트리밍. |
| FAILED 대안(404·codec 없음) | tilesLoaded 는 고쳐지나 **빈 노드를 "실패"로 오표기**(console 스팸·tileFailed 오발) → false alarm. missingTilePolicy 가 의미상 정확. |

## 4. 코드 수정

| 파일 | 변경 |
|------|------|
| `src/decode.worker.ts` | `decode`: missing 노드 → `throw`(표면화), 0점 노드 → `null` 반환(빈 신호, pnts 빌드 skip) |
| `src/copc-tileset.ts` | 핸들러: worker null → `{empty:true}` post. fromUrl: tileset 에 `_runtimeContentCodec` missingTilePolicy 설치 |
| `public/copc-sw.js` | `{empty:true}` → `Response(null,{status:404})` |

변경 줄 추적: ① 빈 노드를 빈 pnts(고착) 대신 빈 신호로 — worker가 0점 노드에 null 반환 ② 그 신호를 SW가
404로 변환 ③ Cesium이 404를 빈 타일로 처리하도록 missingTilePolicy 설치. 셋이 한 메커니즘(빈 노드→Empty 콘텐츠)을 구성.

## 5. 검증

`tsx scripts/bench/repro-03.ts millsite 8` (실 GPU M4 Pro, settle + 8s):

| 지표 | 수정 前 (RED) | 수정 後 (GREEN) |
|------|--------------|----------------|
| `tilesLoaded` | false | **true** |
| `allTilesLoadedFired` | false | **true** |
| `initialTilesLoadedFired` | false | **true** |
| `numberOfTilesProcessing` | 13 (영구 고착) | **0** |
| content state 분포 | READY:44, PROCESSING:13 | **READY:57, PROCESSING:0** |
| 판정 | `RED 확인` | **`PASS ✓`** |

빈 노드 13개가 `Empty3DTileContent`로 READY 전이(44+13=57) → processing 배출. `[REPRO #03] PASS ✓`.

**회귀(수정이 일반 경로를 안 깨는지):**
- `npm run build`(tsc + vite) PASS.
- `npm run verify`(헤드리스 C1 Oregon, 코어 디코드) PASS.
- `npm run bench:eptium -- --target ours --ds millsite --msse 8`: **pointsSelected=712,458 유지**(일반 pnts 렌더 무영향), ttd 14.9s·hitch 0.

**판정: PASS.** RED→GREEN 전환 + 회귀 0. 빈 노드는 이제 Empty 타일(ready·에러 없음)로 처리돼 `tilesLoaded`/`allTilesLoaded`가 정상 동작.

**잔여:** `_runtimeContentCodec`는 Cesium private 필드 — 업그레이드 시 `repro-03.ts`로 가드(회귀 시 RED 재현). 일반 COPC(노이즈 클래스 없는 데이터셋)는 빈 노드가 안 생겨 이 경로 미발동.
