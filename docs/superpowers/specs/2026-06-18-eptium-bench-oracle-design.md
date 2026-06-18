# 설계: Eptium 오라클 벤치 (autzen)

<!-- created: 2026-06-18 · branch: worktree-eptium-bench -->

## 목표 한 줄

autzen 데이터셋에서 우리 `CopcTileset` vs **Eptium**(Hobu `viewer.copc.io`)을 **같은 데이터·같은 뷰포인트·같은 네트워크**로 외부 관측 지표를 떠서, **매 최적화 후 재실행하는 북극성 표**를 만든다.

## 왜 Eptium인가

Cesium 블로그(2025-06-20)가 Eptium을 "consumes COPC on the fly, **converting it into 3D Tiles in-browser**, on CesiumJS"로 설명한다 — 우리 ADR-001 A안과 글자 그대로 동일한 설계의 **성숙한 상용 레퍼런스**. 같은 아키텍처라 비교가 의미 있다(아키텍처가 다르면 "사과 vs 오렌지").

## 확정된 결정

| 항목 | 결정 | 근거 |
|------|------|------|
| 용도 | 엔지니어링 오라클 / 북극성 (객관적 자가측정) | 감독 확정 |
| 신뢰모델 | **2-tier** (1급=재현 가능 파이프라인 지표, 2급=실GPU fps 수동 headline) | 감독 확정 · 코드 주석 기존 결론과 일치 |
| 데이터셋 | **autzen** (`s3.amazonaws.com/hobu-lidar/autzen-classified.copc.laz`) | Hobu 자기 S3 → 양쪽 CORS·range 보장. 스크린샷에서 Eptium이 실제 로드 중인 그 데이터 |
| 하니스 | Playwright + CDP, 우리 측은 기존 `?perf` 재사용 | 재현·자동화 = 오라클 필수. 신규 측정코드 최소화 |

## 측정 3-tier (2-tier를 신뢰도로 정밀화)

| Tier | 지표 | 왜 신뢰 | Eptium 외부 관측법 |
|------|------|---------|---------------------|
| **1a 반석** (북극성 주축) | TTD(풀레솔 도달 ms), 총 bytes, req 수, peak heap MB | "고정 뷰포인트 풀레솔 로드"는 카메라 1점 세팅+완료 감지라 **양쪽 완전 재현** | CDP Network(bytes·req·timing) · `Loading X/Y` DOM(TTD) · `performance.memory`(heap) |
| **1b 경로 의존** (보조) | frametime p95, hitch(>50ms 수), longTask total | **같은 swiftshader** → 헤드리스 프레임 비교는 하드웨어 동일 | 페이지에 rAF·longtask PerformanceObserver **주입** + 동일 카메라 경로 구동 |
| **2 수동 headline** (실 GPU) | steady-state fps median/p95 | 사람이 느끼는 "부드러움" | 실 GPU 머신에서 수동 1회. 헤드리스 fps는 표에 **안 올림** |

**가장 깨끗한 축은 ① 네트워크(bytes·req 수)** — CDP로 양쪽 동일하게 떠지고, "풀레솔까지 몇 MB·몇 요청"은 변환없는 스트리밍 효율의 정직한 척도이자 ADR-001(per-host 동시성 `maxRequestsPerServer` 등)의 핵심 주장과 직결.

## 우리 측 신호 (기존 `?perf` 재사용)

`src/main.ts` `runPerf()` 가 이미 `window.__perf` + `console.log('PERF RESULT ...')` 로 JSON 방출:
`openMs · ttfpMs · ttdMs · frametimeMs{p50,p95,p99} · hitches_gt50ms · longTaskMs{max,total,count} · maxTilesPer16ms · peakHeapMB · peakCesiumMB · tilesLoaded · tileUnloads · avgTilesReady · copcNodes`.
진입: `?perf=autzen&secs=30`. 결정적 카메라 경로(heading 1바퀴 + range 0.5↔0.05 오실레이션). **신규 측정 코드 불필요** — 하니스가 이 JSON을 수집만 한다.

## 정규화 / 통제

- **데이터**: 동일 autzen URL.
- **베이스맵/지형**: 양쪽 **off**. 우리 `?perf`는 이미 점군만; Eptium은 `window.viewer.scene.globe.show=false` + `imageryLayers.removeAll()`로 끔(PoC에서 접근 확인).
- **품질 정규화 = msse 일치 + 고정 뷰포인트 풀레솔** (PoC로 doable 확정): 양쪽 `Cesium3DTileset.maximumScreenSpaceError`를 동일값으로 강제하고(Eptium은 `window.viewer` 통해, 우리는 `&msse=`), `numberOfPointsSelected`를 양쪽에서 읽어 **동일 점 수를 증명**. 풀레솔 도달 = `numberOfPendingRequests===0 && numberOfTilesProcessing===0` 안정(양쪽 동일 Cesium 지표). 헤드라인은 매칭 msse 1쌍(예 32), 보조로 우리 출하기본(8)도 기록.
- **네트워크**: CDP `Network.emulateNetworkConditions` 로 양쪽 동일 프로파일(고정 다운링크/RTT). 무제한도 1회 측정하되, 비교 헤드라인은 throttle 고정값.

## 산출물

1. `scripts/compare-eptium.ts` — Playwright+CDP 1개. 양쪽(우리 `localhost:5173/?perf=autzen` + `viewer.copc.io/?copc=<autzen>`)을 동일 시나리오로 구동·수집.
2. `docs/bench/eptium-autzen.md` — 4축 비교표(우리 값 · Eptium 값 · 차이 · 측정조건 한 줄). 재실행 시 갱신.
3. (선택) `docs/bench/eptium-autzen.json` — 원시 측정치(회귀 추적용).

## PoC 결과 (2026-06-18 실측, Playwright MCP)

스파이크를 계획 전에 먼저 돌려 모든 리스크를 실측으로 걷어냄. `viewer.copc.io/?copc=<autzen>` → `eptium.com` 리다이렉트하며 autzen 정상 렌더.

| 질문 | 결과 | 함의 |
|------|------|------|
| 직링크 로드 | ✅ `?copc=<url>` 직링크로 autzen 로드 (STAC 불필요) | 진입 방식 확정 |
| **Eptium scene 접근** | ✅✅ **`window.viewer` 전역 노출** — `camera.{setView,lookAt,flyTo}` + `scene.primitives.get(1)` = `Cesium3DTileset` with `.statistics` | **1b 반석 승격**. 동일 API 카메라 구동 + 점 수 직독 |
| 로드 완료 감지 | ✅ `statistics.numberOfPendingRequests===0 && numberOfTilesProcessing===0` + `numberOfTilesWithContentReady` 안정 | 우리 `?perf`와 **동일 Cesium 지표** → 양쪽 정의 일치 |
| `performance.memory` | ✅ used 83.7 / limit 4192 MB | 메모리 축 OK |
| 네트워크 | ⚠️ 요청 **수**는 어디서나 관측(autzen 206 range ×22). **바이트는 CDP 전용** | 아래 함정 참조 |

**관측된 Eptium 기준선(autzen, 초기 뷰)**: `msse=32`, `numberOfPointsSelected=577,637`, `numberOfTilesTotal=280` / `loaded=17`, `geometryByteLength≈17.9MB`, `globe.show=true` + imagery 1.

**잡은 함정 2개 (계획에 반영 필수):**
1. **바이트는 CDP로만**: cross-origin S3에 `Timing-Allow-Origin` 없어 Resource Timing `transferSize/encodedBodySize`가 **0**. → 하니스는 CDP 세션 `Network.loadingFinished.encodedDataLength` 합산.
2. **msse 정규화 필수**: Eptium=32 vs 우리 `?perf` 기본=8. 안 맞추면 "덜 그려 빨라보임". → 양쪽 동일 msse 강제 + `numberOfPointsSelected` 동일 증명.

**보너스**: 이 Playwright는 swiftshader가 아니라 **실 GPU**(`ANGLE Metal Renderer: Apple M4 Pro`). → 2급 fps를 **같은 하니스**에서 실GPU값으로 수집 가능(단 자동화 브라우저 fps라는 caveat는 유지, 여전히 2급).

## 검증 기준 (Acceptance Criteria)

- [ ] autzen이 우리 뷰어·Eptium 양쪽에서 로드됨 (스파이크로 확인)
- [ ] 한 명령(`tsx scripts/compare-eptium.ts`)으로 양쪽 자동 측정 → JSON+markdown 표 생성, **재실행 시 재현**(동일 조건 ±합리적 분산)
- [ ] 표에 1a 4지표(TTD·bytes·req수·peakHeap)가 **양쪽 값 + 차이**로 기록되고, 측정 조건(데이터·뷰포인트·네트워크 프로파일·렌더 점 수)이 한 줄로 명시됨
- [ ] Eptium scene 접근 가부가 리포트에 명시되고, 불가 시 1b가 "best-effort"로 라벨됨 (**조용한 실패 없음** — [[no-silent-failures]])
- [ ] fps(2급)는 "실 GPU 수동" 섹션으로 분리, **헤드리스 fps는 표에 안 올림**
- [ ] 측정 코드는 우리 `?perf` JSON을 **수집만** 하고 측정 로직을 중복 구현하지 않음

## 테스트 시나리오

- **정상**: autzen, throttle=고정(예 Fast 3G 또는 무제한 1쌍), 고정 뷰포인트 → 양쪽 1a 4지표 + 1b 프레임지표가 표로 출력. 우리 값은 `?perf` JSON과 일치.
- **엣지(품질 비매칭)**: Eptium scene 접근 불가 → 1b "best-effort" 라벨 + 렌더 점 수 양쪽 그대로 표기, 헤드라인은 1a로만.
- **실패(Eptium 로드 실패/타임아웃)**: `Loading X/Y` 가 N초 내 완료 안 됨 → throw + 리포트에 "Eptium 미측정" 명시(부분표 금지, 조용한 통과 금지).

## 범위 밖 (YAGNI)

- Eptium의 단면·필터·STAC 등 분석 UI 비교 (우리는 렌더/스트리밍 파이프라인만).
- 다중 데이터셋 스윕 (millsite·sofi) — autzen 오라클 안정화 후 별건.
- 합성 점수 한 줄 요약 (가중치 자의성으로 기각됨).
