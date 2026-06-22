# #19 deep-load 내부 병목: laz 디코드(압축해제+XYZ 추출)가 파이프라인의 84%

**Issue**: https://github.com/thissak/CopcCesiumLab/issues/19
**Status**: Open
**Created**: 2026-06-22
**Resolved**: -
**Label**: enhancement (perf / 내부 compute)

> 발견 경로: 4축 병목 분해 하니스(`scripts/bench/profile-axes`·`run-axis-profile`, PR #16)로 내부 계산을 IO/decode/reproject/build 분해 측정. #17(reproject 50%→2%, PR #18)로 reproject 병목을 제거한 직후 **decode가 단일 최대 축(84%)으로 이동** — #17 검증 §5에서 "새 내부 병목 = decode(laz)" 로 예고된 후속 건.

---

## 1. 문제

### 증상
deep-load 노드 처리 파이프라인의 **84%가 laz 디코드(압축해제 + XYZ 추출)**에 소요. IO(5%)·reproject(2%, #17 해결)·build(9%)를 전부 합한 것보다 5배 이상 크다. "느린 deep-load"의 내부 compute 레버는 이제 명백히 **laz 디코드**.

### 재현 조건
- 환경: Node, 로컬 range 서버 + 정규화 COPC(PDAL decimation, autzen 2.13M점), Apple M-series.
- 단계: `bash scripts/bench/gen-norm-copc.sh` → `npm run profile:axes -- data/norm-autzen-2M.copc.laz 5 5`

### 측정 데이터 (norm autzen · depth≤5 · 65노드 · 5회 median · 2.13M점)
| 축 | ms | % | ms/1M점 |
|----|----|---|---------|
| IO(local) | 57.7 | 5% | 27.1 |
| **decode(laz+xyz추출)** | **1047.5** | **84%** | **491.6** |
| reproject(proj4 수평) | 22.8 | 2% | 10.7 |
| build(ecef+양자화+pack) | 117.4 | 9% | 55.1 |
| **internal 합** | **1245.4** | 100% | — |

산출물 `docs/bench/axis-norm-autzen-2M.{md,json}`. 축 경계: decode = laz 압축해제 + XYZ getter 전체 추출(materialize). reproject(proj4 수평)·build(geodeticToEcef+양자화+pnts패킹)는 별도 축.

### 실데이터 확증 (raw autzen 원본 · 비정규화 10.65M점 · depth≤5 · 278노드 · 5회 median)
정규화(1/5 decimation)가 비중을 왜곡했는지 확인하려 원본을 직접 측정 (`data/raw-autzen.copc.laz`):
| 축 | ms | % | ms/1M점 |
|----|----|---|---------|
| IO(local) | 203.1 | 4% | 19.1 |
| **decode(laz+xyz추출)** | **4828.2** | **84%** | **453.2** |
| reproject(proj4 수평) | 111.4 | 2% | 10.5 |
| build(ecef+양자화+pack) | 578.6 | 10% | 54.3 |
| **internal 합** | **5721.3** | 100% | — |

→ 점 5배·노드 65→278개인데 **축 비중·ms/1M점이 norm과 거의 동일**(decode 84%·reproject 2%). decode 84% 병목은 정규화 아티팩트가 아니라 **입력 무관 견고**. 산출물 `docs/bench/axis-raw-autzen.{md,json}`.

- IO를 로컬 서버로 통제(4~5%)했으므로 네트워크 brittle(#14)과 분리된 *내부 compute* 축.

---

## 2. 원인 분석 (Step 2 — 측정으로 확정)

<!-- /issue-resolve Step 2에서 채움 -->
- [ ] decode 축을 (a) laz 엔트로피 압축해제 (b) XYZ getter 추출/materialize 로 더 분해 — 어느 쪽이 dominant인지 마이크로벤치로 격리
- [ ] laz-perf WASM 디코드 경로 확인 (copc.js `loadPointDataView` → laz-perf): 점당 비용 vs 호출 오버헤드 vs WASM↔JS 경계 복사
- [ ] 코드 위치: `src/copc-core.ts` decodeNode / loadCopcPoints 의 디코드 구간

### 측정 데이터
{Step 2}

### 근본 원인
{Step 2}

---

## 3. Best Practice 조사 (Step 3 — context7 + 실측)

<!-- /issue-resolve Step 3에서 채움 -->

### 조사 항목
- laz-perf 디코드 가속 옵션: 필요 차원만 디코드(XYZ만, RGB/intensity 등 미사용 속성 skip), SoA getter 일괄 추출 vs 점별 getter 호출, WASM SIMD 빌드, 워커 병렬(이미 comlink 워커 사용 중 — #02).
- COPC/LAZ 디코드 prior art: copc.js·PDAL·potree/Entwine 디코드 경로, laz-rs/laz-perf 벤치.

### 프로덕션 사례
| 프로젝트 | 접근 방식 | 비고 |
|---------|----------|------|
| {Step 3} | | |

### 엣지 케이스 / 위험 요소
| 시나리오 | 위험도 | 대응 |
|---------|--------|------|
| 디코드 결과 정확성 회귀 | 높 | verify C1 좌표 동일 + 골든 비교 |
| 미사용 속성 skip 이 후속 기능(색상/분류) 요구와 충돌 | 중 | 현재 사용 차원만 측정·근거化 |

---

## 4. 수정 내용 (Step 4 — BP 적용)

<!-- /issue-resolve Step 4에서 채움 -->

### 변경 파일
| 파일 | 변경 요약 |
|------|----------|
| {Step 4} | |

### Before / After
```typescript
// Step 4
```

### PR
{close 시}

---

## 5. 검증 결과 (Step 5 — RED→GREEN, 무회귀)

<!-- /issue-resolve Step 5에서 채움 -->

### 테스트 방법
{Step 5}

### 결과
| 항목 | 수정 전 | 수정 후 | 판정 |
|------|---------|---------|------|
| decode ms/1M점 | 487.0 | {Step 5} | |
| internal compute 합 | 1233.9ms | {Step 5} | |
| BOTTLENECK | decode(84%) | {Step 5} | |
| 정확도 (verify C1) | PASS | {Step 5} | |

### 잔여 이슈
{Step 5}

---
스코프: 내부 compute decode(laz) 한정. 네트워크 brittle은 #14, reproject는 #17(해결), GPU/메인스레드 축은 4축 하니스 후속(GPU 미구현).
