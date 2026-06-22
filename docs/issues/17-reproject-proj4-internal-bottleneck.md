# #17 deep-load 내부 병목: reproject(proj4 수평변환)가 내부 compute의 50%

**Issue**: https://github.com/thissak/CopcCesiumLab/issues/17
**Status**: Resolved (PR #18 머지, dual-review 2R 통과)
**Created**: 2026-06-22
**Resolved**: 2026-06-22
**Label**: enhancement (perf / 내부 compute)

> 검증 보강(dual-review PR #18): R1서 오차 가드가 셀중심 1점만 샘플 → bilinear 최대오차(saddle/방향성 곡률)를 놓쳐 LCC서 cm 통과하던 결함을 **셀당 다점(중심+4 모서리중점)**으로 건전화. R2서 양쪽(Red/Blue) 독립 확인(실 proj4 32구성 false-pass 0) + 회귀에 **LCC 8km 격자-채택 케이스**(격자 path 자체 <1mm) 추가, V4 게이트 1cm→1mm 정정.

> 발견 경로: 4축 병목 분해 하니스(이슈 #14 후속, `scripts/bench/profile-axes`·`run-axis-profile`, PR #16)로 내부 계산을 IO/decode/CPU 분해 측정 중 발견. 네트워크(IO=TTFB) 축은 #14, 본 건은 *내부 compute* 축 1순위.

---

## 1. 문제

### 증상
deep-load 노드 처리의 **내부 계산(IO 제외) 시간 50%가 reproject(proj4 수평 좌표변환)**에 소요. laz 디코드(43%)보다 크다. IO를 로컬 서버로 통제(3%)하면 reproject가 단일 최대 축으로 드러남. "느린 deep-load"의 내부 compute 레버는 디코드가 아니라 **좌표 재투영**.

### 재현 조건
- 환경: Node, 로컬 range 서버 + 정규화 COPC(PDAL decimation, autzen 2.13M점), Apple M-series.
- 단계: `bash scripts/bench/gen-norm-copc.sh` → `npm run profile:axes -- data/norm-autzen-2M.copc.laz 5 5`

### 측정 데이터 (depth≤5 · 65노드 · 5회 median · ×2회 재현, 축% 변동 0%p)
| 축 | % | ms/1M점 |
|----|---|---------|
| IO(local) | 3% | 32.5 |
| decode(laz+xyz추출) | 43% | 504.9 |
| **reproject(proj4 수평)** | **50%** | **582.2** |
| build(ecef+양자화+pack) | 5% | 55.8 |
| internal 합 | 100% | (2504ms / 2.13M점) |

- raw autzen 로컬서빙에서도 동일(IO 3 · decode 42 · reproject 50 · build 5) → 입력 무관 견고.
- 축 경계: reproject = proj4 수평(lon/lat)만. (build의 geodeticToEcef는 별도 축.)

### 결정적 재현 (Step 1, `scripts/bench/check-reproject.ts`)
실 autzen CRS(Lambert→WGS84)로 합성 2M점 변환 — 하니스 의존 없이 reproject 비용만 격리:
```
V0 현재(새배열+forward+push) : 1149ms = 574.4 ms/1M점   ← 하니스 582와 일치(재현 ✅)
V1 배열재사용(할당제거)        : 1128ms = 563.9 ms/1M점   (Δ 2%)
```

---

## 2. 원인 분석 (Step 2 — 측정으로 확정)

### 측정 데이터
- 하니스: reproject 50% / 582 ms/1M점 (정규화·raw 일치, 2회 변동 0%p).
- 마이크로벤치: **V0(현재) 574 vs V1(배열 재사용) 564 → Δ 2%뿐.**

### 근본 원인 (확정)
비용은 **배열 할당/JS 오버헤드가 아니라 `proj4.forward`의 투영 수학 자체**다. V0≈V1(할당 제거가 2%만 절감)이 이를 증명. 즉 점마다 **Lambert Conformal Conic 역투영 + (NAD83→WGS84) 데이텀 변환**을 proj4 범용 경로로 계산하는 비용(~570ns/점)이 dominant.
- 위치: `src/copc-core.ts` `loadCopcPoints`(~119-126)·`decodeNode`의 점 루프 `toWgs.forward([x, y])`.
- 함의: **배열 재사용 같은 미세최적화로는 못 잡음**. 레버 = 점당 투영 수학을 줄이는 것(예: 범용 proj4 경로 우회 / bounded extent 근사 / 데이텀 변환 비용 제거). → Step 3 BP 조사로 안전한 방법 확정(정확성 회귀 위험 = 좌표 오차).

---

## 3. Best Practice 조사 (Step 3 — context7 + 실측 검증)

### 조사 결과
- **proj4js: 배치 API 없음.** 재사용 변환기(`proj4(from,to)` → forward/inverse)만 제공 — 이미 `resolveCrs`서 1회 생성·재사용 중. 점당 비용 = 투영 수학 자체(§2 V0≈V1로 확정). 점당 배열할당 제거(V1)는 2%뿐.
- **핵심 BP = bounded-extent 근사.** COPC는 유한 영역(autzen extent 3426×4655 projected unit ≈ 1km×1.4km). Conformal 투영(Lambert)은 소영역서 거의 선형 → **(G+1)×(G+1) proj4 control 격자 + 점별 bilinear 보간**으로 점당 수학을 제거. 격자 오차는 셀크기²로 급감.

### 실측 (measure-first 검증, `scripts/bench/check-reproject.ts`, 2M점)
| 방식 | ms/1M점 | 속도 | max 오차 |
|------|---------|------|---------|
| V0 proj4 per-point (현재) | 565 | 1× | (기준) |
| V2 단일셀 bilinear (4 proj4) | 4.6 | 124× | 21mm ❌ |
| **V3 격자 G=8×8 (81 proj4)** | **12.3** | **46×** | **0.33mm** ✅ |
| V3 격자 G=16×16 (289 proj4) | 8.3 | 68× | 0.08mm ✅ |

→ 격자 G로 오차를 sub-mm까지 자유 조절하며 수십× 가속. lidar 정밀도(cm~dm)·렌더 픽셀 훨씬 아래라 시각·정확성 무해.

### 엣지 케이스 / 위험 요소
| 시나리오 | 위험도 | 대응 |
|---------|--------|------|
| 대형 extent(대륙급 COPC) → bilinear 오차↑ | 높 | **셀당 다점(중심+모서리중점)서 proj4 대비 max오차 측정 → 임계 초과면 proj4 per-point 폴백**(가드) |
| 비-conformal / 비정상 CRS | 중 | 동일 오차 가드가 자동 폴백 |
| 격자 빌드 비용 | 낮 | **데이터셋당 1회**(copc.header bounds 기준), 노드마다 X. (G=8 → 81 proj4) |
| 점이 격자 밖 | 낮 | 격자 = 데이터 bounds → 내부 보장 + 셀인덱스 clamp |
| 정확성 회귀 | 높 | verify C1(center in Oregon) + 오차 가드(<임계) + (있으면)골든파일 |

### 결론
**데이터셋 bounds 기준 (G+1)² proj4 격자 + 점별 bilinear, 셀당 다점 오차 가드(<임계 시 proj4 폴백).** G는 오차 임계 충족까지 자동 상향. proj4 범용 정확성은 폴백으로 보존.

---

## 4. 수정 내용 (Step 4 — BP 적용)

### 변경 파일
| 파일 | 변경 요약 |
|------|----------|
| `src/copc-core.ts` | `makeGridReprojector`(+`GridReproj`) 신설 — 데이터 bbox 위 (G+1)² proj4 격자 + 점별 bilinear, 셀당 다점 오차 가드(기본 ~1mm, G 자동 상향, gridMax 64), 미달 시 proj4 per-point 폴백. `CopcSession.reproj` 필드. `openCopc`·`decodeNode`·`loadCopcPoints` 가 점별 `toWgs.forward([x,y])` → `reproj.forward(x,y)`. `checkCenterInRange`/`resolveCrs` 는 toWgs 유지(불변). |
| `scripts/bench/check-reproject.ts` | 신규 — 재현/진단/검증 벤치(V0 proj4 vs V2~V4 격자, 정확도·속도). |
| `scripts/bench/axis-measure.ts`·`profile-axes.ts`·`run-axis-profile.ts`·`check-axis-measure.ts` | 4축 하니스 measureNode 가 격자 reproj 측정(프로덕션 동기화) — 데이터셋당 1회 빌드. |

### Before / After (핵심)
```ts
// Before — 점마다 proj4 범용 변환 (deep-load 내부 compute 의 50%)
const out = toWgs.forward([x, y]);

// After — 데이터셋당 1회 격자 빌드 + 점별 bilinear (proj4 폴백 내장)
const reproj = makeGridReprojector(toWgs, copc.header.min, copc.header.max);
const out = reproj.forward(x, y);   // 격자 bilinear (대형 extent/비정상 CRS면 proj4 폴백)
```

### PR
feat/17-reproject-proj4-internal-bottleneck (close 시 PR/머지)

---

## 5. 검증 결과 (Step 5 — RED→GREEN, 무회귀)

### 테스트 방법
- 재현/속도/정확도: `scripts/bench/check-reproject.ts` (실 autzen CRS, 2M점, V0 proj4 vs V4 실 src 함수).
- end-to-end: `npm run profile:axes -- data/norm-autzen-2M.copc.laz 5 5` (4축 하니스, 정규화 COPC).
- 정확성: `npm run verify` (autzen C1, loadCopcPoints→격자 reproj). 회귀: check-coalesce/retry/profile-axes/serve/tsc/build.

### 결과
| 항목 | 수정 전 | 수정 후 | 판정 |
|------|---------|---------|------|
| reproject ms/1M점 (src 함수, V4) | 572 | **9** | PASS (64×) |
| reproject ms/1M점 (하니스 e2e) | 582 (50%) | **10.7 (2%)** | PASS (54×) |
| **internal compute 합** | **2504ms** | **1245ms** | PASS (~2×) |
| BOTTLENECK | reproject | **decode(laz 84%)로 이동** | PASS |
| 정확도 (max 오차 vs proj4) | 0 (proj4) | **0.33mm** (<1mm 가드) | PASS |
| verify C1 (center in Oregon) | PASS | PASS (좌표 동일) | PASS |
| 회귀 (coalesce/retry/profile-axes/serve/tsc/build) | — | 전부 PASS | PASS |

→ **reproject 병목 제거(50%→2%, 54×), 내부 compute 절반.** 격자 bilinear는 sub-mm(lidar 정밀도·렌더 훨씬 아래) + extent/오차 가드로 proj4 정확성 보존.

### 실데이터 사후검증 (2026-06-22 — 합성 점 caveat 해소)
위 정확도 검증(§1·§3)은 실 autzen CRS·bounds 위 **합성 균일격자 점**이었다(좌표계·extent는 실제, 점 분포는 합성). 원본 raw autzen에서 **실제 점 6M개를 디코드**해(`scripts/bench/check-reproject-realpts.ts`) grid bilinear vs proj4 per-point을 재검증:

| 항목 | 합성 균일격자 (기존) | raw 실제 점 6M (신규) |
|------|------|------|
| max 오차 | 0.329mm | **0.329mm** (mean 0.227mm) |
| 속도 | 54~88× | **≈88×** (proj4 565 → 격자 6.5 ms/1M점) |
| 경로 | 격자 채택 | **격자 채택 (proj4 폴백 0회)** |

→ 실제 라이다 점 분포(지형·건물 집중)에서 max 오차가 **합성 worst-case와 정확히 일치(0.329mm)** — 합성 균일격자가 오차 상한을 정직하게 잡고 있었음이 실증. 실 점 mean은 0.227mm로 더 낮다. autzen extent에선 가드가 격자를 수락(폴백 불필요). 4축 e2e도 raw 10.65M에서 reproject 2% 동일([#19](19-decode-laz-internal-bottleneck.md) §1 실데이터 확증).

### 잔여 이슈
- 새 내부 병목 = **decode(laz, 84%)** — 별건 후속 [이슈 #19](19-decode-laz-internal-bottleneck.md)로 등록(laz-perf 디코드).
- attribute batch 미측정·GPU 축 미구현은 4축 하니스 기존 한계(스코프 외).
- 격자 reproj 의 per-call `[lon,lat]` 할당은 잔여(동시성 안전 위해 유지) — 추가 가속 시 batch 형태 가능(현재도 54× 충분).

---
스코프: 내부 compute reproject 한정. 네트워크 brittle은 #14, GPU/메인스레드 축은 4축 하니스 후속(GPU 미구현).
