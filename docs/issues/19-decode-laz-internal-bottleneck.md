# #19 deep-load 내부 병목: laz 디코드(압축해제+XYZ 추출)가 파이프라인의 84%

**Issue**: https://github.com/thissak/CopcCesiumLab/issues/19
**Status**: Won't-fix 후보 (분석 완료 — 대회 S3/IO-bound 레짐서 워커풀 net-zero)
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

### 결정적 재현·분해 (Step 1, `scripts/bench/check-decode.ts` — in-memory getter로 IO=0)
decode 축을 **laz 압축해제 vs getter 추출**로 가름 (norm autzen, 65노드·2.13M점, 5회 median):
| 구성 | ms/1M점 | decode 내 비중 |
|------|---------|---------------|
| **압축해제 (decompressChunk · laz-perf WASM · 전체 레코드)** | **452.2** | **92%** |
| XYZ 추출 (getter 3N · JS DataView 읽기) | 37.9 | 8% |
| └ 프로덕션 decode 합 (none+xyz) | **490.1** | (프로파일러 487~491과 일치 → 재현 ✅) |
| (참고) 전 21차원 추출 상한 | 201.3 | — |

- 데이터 특성: **PDRF 7 · 36 B/점 · 21차원**(autzen-classified: RGB·classification·GPS time 등). 우리는 **3차원(X/Y/Z)만** 사용.
- → **decode 비용의 92%가 laz WASM 압축해제.** getter 추출(8%)은 이미 최소(21차원 중 3개만 읽음).

---

## 2. 원인 분석 (Step 2 — 측정으로 확정)

### 측정 데이터
- 하니스: decode 84% / 487~491 ms/1M점 (norm·raw 일치, §1).
- 분해(Step 1): **압축해제 452 (92%) ≫ getter 추출 38 (8%).** 전 차원 추출조차 201(<압축해제). 즉 비용은 추출 루프가 아니라 **압축해제 자체**.

### 근본 원인 (확정)
비용은 **laz-perf WASM의 청크 압축해제**다. copc.js `loadPointDataView`(`src/copc-core.ts` `decodeNode`·`loadCopcPoints`)는 `decompressChunk`로 청크의 **전체 포인트 레코드(36 B/점·21차원)를 eager 압축해제**하고, getter는 그 평평한 버퍼를 DataView로 읽을 뿐(압축해제 아님).
- **함의 1 (차원 skip 불가)**: LAZ는 포인트 레코드 단위 엔트로피 압축(차원이 인터리브). copc.js `include` 옵션은 **getter만 필터**할 뿐 압축해제는 여전히 전체 레코드 → "XYZ만 디코드"로 비용을 못 줄인다(측정: 추출만 8%, 압축해제는 차원 수 무관).
- **함의 2 (getter 미세최적화 무의미)**: 추출은 8%뿐 → bulk/typed-array로 추출을 0으로 만들어도 decode는 8%만 감소.
- **레버 후보**: 압축해제 자체를 줄이는 것뿐 — (a) 더 빠른 디코더/SIMD 빌드, (b) 디코드 병렬화(워커 다중화 — 처리량↑, 지연↓ 아님 · 동시성 STOP·ADR-004 검토), (c) 입력 차원 축소(데이터 prep, 런타임 라이브러리 스코프 밖). → **정확성 회귀 위험 없는 안전한 레버가 있는지 Step 3 BP로 확정**(없으면 won't-fix 근거화).

---

## 3. Best Practice 조사 (Step 3 — context7 + 실측)

### 조사 결과 (deep-research + laz-perf .wasm 직접 파싱)
- **laz-perf 0.0.7 = npm 마지막 버전**(2025-02 이후 신버전 없음). shipped `.wasm`은 **스칼라·단일스레드**(SIMD prefix 오탐 수준·SharedArrayBuffer/Atomics 0). upstream 빌드 플래그에 `-msimd128`·`-pthread`·`-O3` **모두 없음**. → SIMD 가속은 **자체 재빌드 필요, 이득 미지**(벤치 부재 + 산술코더는 데이터 의존 분기 多 → SIMD 친화도 낮을 개연).
- **드롭인 가능한 더 빠른 COPC 호환 WASM 디코더 없음**: laz-rs(crate)는 활발하나 SIMD 없음(가속=rayon 멀티스레드)·laz-rs-wasm은 방치(2021)·copc.js `ChunkDecoder.open()+getPoint()` per-point 계약과 비호환(whole-file 디코더).
- **getter 차원 skip 불가 재확인**: copc.js `include`는 getter 필터만 — 압축해제는 전체 레코드(§2 측정 일치).

### 프로덕션 사례 (디코드 전략)
| 프로젝트 | 전략 | SIMD? | 워커풀? | 출처 |
|---------|------|-------|---------|------|
| Potree | Worker | No | 무제한 풀 + in-flight 4 | `WorkerPool.js` |
| loaders.gl(`@loaders.gl/las`) | Worker | No | maxConcurrency 1/farm 3 | `worker-pool.ts` |
| **giro3d**(동일 스택: copc.js `decompressChunk`) | Worker | No | **`hardwareConcurrency` cap** | MR!750 |
| CesiumJS Draco | TaskProcessor | N/A | **`max(hwConc-1,1)`** | `DracoLoader.js` |
| aolagers/pointz(COPC 뷰어) | Worker | No | 고정 4 | `worker-pool.ts` |
| copc.js | 호출자 스레드 | No | 없음 | `src/` |

→ **워커풀이 표준 prior art**(손코딩 primitive 아님), **SIMD를 ship하는 뷰어는 0개.**

### 엣지 케이스 / 위험 요소
| 시나리오 | 위험도 | 대응 |
|---------|--------|------|
| **decode 84%는 internal-compute 비중 ≠ wall-clock 비중** | (게이트) | 실 S3는 IO(TTFB)가 wall-clock 지배(#14·#02). **착수 전 reproject-fix 이후 레짐서 wall-clock A/B 재측정 필수** |
| 워커풀 N개 × 2GB heap OOM | 높(메모리) | cap `max(hwConc-1,1)`(Cesium식) + heapMB 모니터(#04 계측 재활용) |
| 워커풀 ↔ range-coalescing race(#04 재현) | 중(안정성) | 풀-coalescing 경계 분리 + slice 무결성 assert |
| SIMD 재빌드 후 출력 차이 | 낮(산술코더 결정적) | byte-identical 골든 게이트(#02 운용 중) |
| SIMD 실이득 ≈ 0 | 이득 미지 | 재빌드 전 `-msimd128` .wasm A/B 측정 선행 |
| laz-rs 교체 | 높(정확성·비호환) | **비권장** |

### 결론 (안전 레버 우선순위 + 정확성 회귀 위험)
1. **워커풀** — 정확성 회귀 **없음**(디코드 chunk별 결정적 → 출력 byte 불변). 동일 스택 prior art 실재. **단 채택 게이트 2개**: (a) decode-dominant 레짐서 deep-load **wall-clock A/B 재측정**(과거 #02 풀 A/B는 IO-bound 시절이라 무효), (b) cap `max(hwConc-1,1)` + 2GB×N heap 모니터.
2. **SIMD laz-perf 재빌드** — 위험 **낮음**, 단 **이득 미지** → `-msimd128` A/B + 골든 통과 시에만.
3. **laz-rs 교체** — **비권장**(위험 높음).

**intrinsic 판정**: *단일 chunk 레이턴시*(~452 ms/1M)는 stock 빌드 한 거의 intrinsic. *deep-load 스루풋*은 워커풀로 N배 잠재이나 **실 wall-clock 체감 이득은 IO 레짐에 묶임** — #02 워커풀 revert 논리(IO-bound)가 reproject-fix 이후에도 유효한지 **재측정이 선결**.

---

## 4. 결정 (Step 4 — 측정 게이트: 프로덕션 코드 미작성)

BP(§3)에서 정확성 회귀 없는 레버는 **워커풀**(prior-art 표준) 하나뿐이고 그 이득이 IO 레짐에 묶임이 드러나, 코딩 전 **wall-clock 게이트**를 측정(`scripts/bench/check-decode-wallclock.ts`):

| 레짐 | deep-load wall-clock | decode 비중 | 워커풀 N=4 | 천장(N→∞) |
|------|---------------------|------------|-----------|----------|
| LOCAL(빠른 IO, 측정) | 1230ms | 84% (1036ms) | 2.71× (−777ms) | 6.33× |
| **S3(IO-bound, #02 실측 참조)** | **~4800ms** | **~1%** | **1.008×** | 1.01× |

**대회 배포 가정 = S3(일반적 클라우드 오브젝트 스토리지).** 그 레짐서 decode는 wall-clock의 ~1% → 워커풀 net-zero(#02서 동일 이유로 이미 만들었다 revert). 단일 chunk 압축해제는 stock laz-perf 한 **intrinsic**(SIMD 미제공·이득 미지, 대체 디코더 비호환·§3). → **프로덕션 `src/` 무변경.**

### 변경 파일 (측정/진단 도구만 — src 무변경)
| 파일 | 변경 요약 |
|------|----------|
| `scripts/bench/check-decode.ts` | 신규 — decode를 압축해제 vs getter 추출로 분해(92% vs 8% 확정) |
| `scripts/bench/check-decode-wallclock.ts` | 신규 — decode wall-clock 비중 + 워커풀 Amdahl 천장 레짐별 측정(착수 게이트) |
| `src/**` | **무변경** — 워커풀은 대회 S3 레짐서 net-zero라 미착수 |

---

## 5. 판정 (Step 5 — measure-first 결론: WON'T-FIX)

### 테스트 방법
- decode 분해: `npx tsx scripts/bench/check-decode.ts data/norm-autzen-2M.copc.laz 5 5`
- wall-clock 게이트: `npx tsx scripts/bench/check-decode-wallclock.ts data/norm-autzen-2M.copc.laz 5 3`

### 결과
| 항목 | 측정 | 판정 |
|------|------|------|
| decode 내 압축해제 vs 추출 | 92% (laz WASM) vs 8% (getter) | 추출 미세최적화 무의미 |
| decode = internal-compute 비중 | 84% | (IO 통제 시에만) |
| decode = **wall-clock** 비중 (S3) | **~1%** | 워커풀 무이득 |
| 워커풀 speedup (S3 레짐) | **1.008×** (N=4) | net-zero |
| 워커풀 speedup (fast-IO 레짐) | 2.71× (N=4) | 조건부 이득(배포 의존) |

### 결론: WON'T-FIX (분석 완료)
대회 배포(S3/IO-bound) 가정에서 decode 최적화의 유일 안전 레버(워커풀)는 **net-zero**. 실 deep-load wall-clock 레버는 **IO(TTFB round-trip)** 이며 #14(brittle)·#02(coalescing)가 담당 — decode 아님. "decode 84%"는 IO를 로컬로 통제했을 때의 *internal-compute* 비중일 뿐. **measure-first가 #02 워커풀 재구현(net-zero)을 코딩 전에 차단함**(이번 사이클의 성과).

### 잔여 / 재개 조건
- 단일 chunk 압축해제는 stock laz-perf(0.0.7·SIMD 미제공) 한 **intrinsic** — 런타임 라이브러리 스코프서 더 못 줄임.
- **재개 조건**: 배포가 fast-IO(로컬·CDN·웜캐시)로 확정되면 워커풀이 2.71×(N=4) 후보 — prior-art·정확성 안전, cap `max(hwConc-1,1)`+heap 모니터(#04), wall-clock A/B 게이트 재측정 후. SIMD 빌드는 자체 컴파일+`-msimd128` A/B 선행.

---
스코프: 내부 compute decode(laz) 한정. 네트워크 brittle은 #14, reproject는 #17(해결), GPU/메인스레드 축은 4축 하니스 후속(GPU 미구현).
