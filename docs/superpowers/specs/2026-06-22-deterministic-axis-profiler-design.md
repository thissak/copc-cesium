# 결정적 4축 병목 분해 하니스 — 설계 (Node 3축 우선)

> created: 2026-06-22 · 상태: 설계(승인 대기) · 연관: 이슈 #14(측정 신뢰도 계기), `docs/PROFILING.md`(4축 프레임워크), `docs/bench/FINDINGS.md`(fair-compare 한계)

## 1. 문제 (왜 지금 지표가 "안 잡히나")

기존 측정(`fair-compare`/`probe-matched`/`compare-eptium`/`profile-io`)은 인프라는 멀쩡하나 **비교·진단 기준선이 흔들린다**:

1. **두 엔진이 다른 작업을 한다** — ours(SSE refine + 2M 예산) vs Eptium(고정 점예산, 뷰포트·회차 의존 764k→437k). 같은 설정도 그리는 점 수가 달라 비교 불가, overlap 2버킷뿐.
2. **GPU 곡선 비선형 노이즈** — 점 1.3배 → GPU 4.6배. 점 수 미세 차가 gpuMs 폭증.
3. **Eptium 블랙박스** — config 매프레임 덮어쓰기·plateau 불안정 → 고정·재현 불가.
4. **입력이 실 S3 + 축 경계 뭉개짐** — S3 throttle 비결정적, 워커 fetch가 CDP blind, `decode.worker.ts:90`의 `decodeMs`가 `fetch+laz+reproject`를 한 덩어리로 잡음.

**목적(확정)**: ours 내부 계산 파이프라인의 **병목을 4축(IO/decode/CPU/GPU)으로 결정적·반복가능하게 분해.** 1차 = 내부 계산(decode/reproject/build), 네트워크는 통제로 제거해 내부 축이 가려지지 않게 한다. Eptium 비교는 비목표.

## 2. 스코프

> **축 매핑(명확화)**: PROFILING 4축 = IO/decode/CPU/GPU. 이 spec의 "Node 3축" = **IO · decode · CPU**(CPU를 `reproject`+`build` 두 하위슬라이스로 분해 측정). GPU(4번째 축)는 후속. 즉 4개 측정값(IO/decode/reproject/build)이 3개 축에 대응한다.

**IN (이 spec):**
- Node 결정적 측정 — **IO**(로컬 fetch), **decode**(laz-perf), **CPU = reproject**(proj4) + **build**(pnts 양자화).
- PDAL로 생성한 **정규화 COPC**(고정 점수·bounds·속성), **로컬 정적 서버**로 서빙.
- 4축 분해 리포트(축별 ms·% + **점수 정규화 ms/1M점**), JSON+md.

**OUT (후속, 별도 spec):**
- GPU 축(브라우저, 기존 `fair-probe.ts` GPU 타이머 재사용).
- 메인스레드 CPU(Cesium 순회·SSE·버퍼 업로드 — Node에서 안 보임, 브라우저 필요).
- Eptium 비교, 네트워크 throttle 스윕.

## 3. 아키텍처

```
[PDAL 파이프라인] 실 COPC → 고정 점수·bounds·속성 정규화 → norm.copc.laz
        │  (생성 스크립트 커밋, 산출물은 data/ 캐시)
        ▼
[로컬 정적 서버] norm.copc.laz 서빙 (IO 변동 제거 = 디스크 수준)
        ▼
[Node 하니스] copc.js 로 열기 → 고정 노드집합(depth ≤ D) → 노드마다 축 경계 타이머
        IO → decode → reproject → build  (K회 median)
        ▼
[리포트] 축별 ms·% + ms/1M점 → BOTTLENECK 한 줄
```

세 컴포넌트는 독립: COPC 생성기(PDAL), 로컬 서버(정적), 측정 하니스(Node). 각각 따로 테스트·이해 가능.

## 4. 정규화 COPC (PDAL)

- **파이프라인**: `readers.copc`(실데이터: autzen 또는 millsite) → `filters.decimation`(step 고정) 또는 `filters.sample`(고정 간격) → `writers.copc`(고정 출력).
  - 실데이터 기반이라 **공간 일관성 보존** → laz decode/IO 비용이 현실적(조사 근거: LAZ는 인접점 예측 압축이라 무작위 합성은 decode/byte가 거짓).
- **통제 파라미터**: 목표 점수(예 2M, ours 기본 pointBudget과 일치), 고정 bounds, 고정 속성 집합(XYZ + RGB + Classification 등 명시).
- **결정성**: decimation step 고정 → 동일 입력서 동일 산출(점수·bounds 동일).
- **산출물 관리**: PDAL 파이프라인 JSON + 생성 셸 스크립트는 **커밋**. 산출 `.copc.laz`(~수십MB)는 `data/`(gitignore) 캐시 + README에 재생성 1줄.
- **의존성**: PDAL(별도 바이너리, brew/conda). README에 설치 안내. CI는 산출물 캐시 또는 생성 스킵.

## 5. 축 경계 계측 (핵심 작업)

프로덕션 `src/` **무수정** — 하니스가 동일 프리미티브를 경계 타이머로 호출:

| 축 | 측정 방법 |
|----|-----------|
| **IO** | 계측 getter: `dispatch→헤더`(TTFB) + `헤더→끝`(body) ms (`measure-ttfb.ts` 방식). 로컬이라 작음. |
| **decode** | `Copc.loadPointDataView` 총 ms − IO ms (= laz-perf 압축해제). |
| **reproject** | `view.getter('X'/'Y'/'Z')` 읽기 + `proj4.forward` 루프 ms. |
| **build** | `buildQuantizedPnts(...)` ms (pnts 양자화). |

- **고정 노드집합**(기본): `Copc.loadHierarchyPage` → **depth ≤ D 전체**(D는 인자, 결정적·재현가능). 옥트리 자연 단위라 기본 채택; 대안(offset 순 첫 N)은 노드 수를 직접 고정하고 싶을 때만.
- **K회 median**(예 5회) + 워밍업 1회 제외 → 머신 노이즈 흡수.

### ⚠️ 검증 필요 위험 (구현 시)
- **laz-perf eager vs lazy**: `loadPointDataView`가 디코드를 즉시 하는지(eager) 첫 `view.getter` 호출 시 하는지(lazy) 확인. lazy면 decode 시간이 reproject로 새어 축 오염 → 직후 1차원 전체 강제 materialize로 decode 축에 귀속. (Acceptance Criteria #4로 실증.)
- **buildQuantizedPnts Node 실행성**: 순수 TypedArray/DataView라 Node 동작 예상 — import 가능·Node-safe 확인.

## 6. 출력 ("clear한 지표")

```
=== 4축 분해 (norm-autzen-2M · depth≤D · N노드 · M점 · 5회 median) ===
축                    ms      %     ms/1M점
IO(local)              8     2%      4
decode(laz+xyz추출)  340    57%    170   ◄ BOTTLENECK
reproject(proj4 수평) 95    16%     48
build(ecef+양자화+pack) 70  12%     35
(GPU)                  —     —       —     ← 후속(브라우저)
─────────────────────────────────────────
internal             513   100%
```

> **노트**: build 축은 `buildQuantizedPnts` 전체(geodeticToEcef 고도→ECEF 삼각변환 포함)를 측정하므로, "build 병목"은 ECEF 좌표변환+패킹 합산이다. 또한 production이 넘기는 attribute batch 없이 측정되므로 속성 데이터 부분은 과소 측정.
- **점수 정규화(ms/1M점)** 병기 → 노드집합/데이터 바꿔도 축 비중 비교 가능.
- JSON(기계) + md(사람) 산출 — 기존 `docs/bench/` 패턴.

## 7. 결정성 전략

- 로컬 정적 서버(IO 변동 제거) · 고정 COPC · 고정 노드집합 · K회 median · 워밍업 제외.
- 동일 입력 K회의 축% 변동 < ~5%p 목표(AC #3).

## 8. 검증 기준 (Acceptance Criteria)

- [ ] **정규화 COPC 결정적**: PDAL 스크립트 2회 생성 → 점수·bounds·속성 동일.
- [ ] **4축 분리 출력**: IO/decode/reproject/build 4개 ms 분리, 합 ≈ 노드 총처리시간 ±5%.
- [ ] **결정성**: 동일 입력 5회 median의 축% 변동 < 5%p.
- [ ] **decode↔IO 분리 정확성**: 인위적 지연 getter로 IO만 부풀려도 decode ms 불변(cross-run JIT·머신 변동 감안 ±40% — ±5%는 비현실적).
- [ ] **점수 정규화**: ms/1M점 출력 → 노드집합(depth D) 바꿔도 축 비중 안정.
- [ ] **프로덕션 무수정**: `src/` diff 0 (하니스 `scripts/bench/` + PDAL 스크립트만 추가).

## 9. 테스트 시나리오

- **정상**: autzen 정규화 2M, depth≤D → 4축 표 출력, 합 ≈ 총시간.
- **엣지**: 0점 노드 / 단일 노드 / 속성 없는(XYZ만) COPC → 크래시 없이 0 또는 스킵.
- **실패/검증**: 인위적 200ms 지연 getter → IO 축만 +200ms, decode/reproject/build 불변(축 분리 입증).

## 10. Out of scope (명시)

GPU 축(후속·브라우저) · 메인스레드 CPU 축 · Eptium 비교 · throttle 스윕 · 무작위 합성 COPC(decode 비현실).
