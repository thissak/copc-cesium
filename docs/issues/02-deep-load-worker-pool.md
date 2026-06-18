# #02 deep-load 느림 — 단일 디코드 워커 직렬화

Status: Resolved(후보) · Label: enhancement(perf) · Branch: issue-02-io-profile
선행: #01(refine calibration) 해결 후 드러난 잔여 격차. 근거: `docs/bench/FINDINGS.md` v3 #2.

## 1. 문제 (재현)

#01 수정으로 refine *양*은 맞췄으나(millsite msse=8 tilesReady 79, 728k점), **deep-load 속도**가 느림:

| | ours | eptium(ref) |
|--|------|--------|
| millsite msse=8 settle | **ttd=25s 미settle**(728k에서 계속 스트리밍) | 7.3s settle, 1.49M |

재현: `npm run bench:eptium -- --ds millsite --msse 8` → ours `ttd≈25000`(타임아웃 cap). 첫 시도 flaky 실패도 관측됨.

## 2. 원인 분석 (근본, 코드 확인)

`src/copc-tileset.ts:67` — 디코드 워커를 **1개만** 생성:
```ts
worker = new Worker(new URL('./decode.worker.ts', import.meta.url), { type: 'module' });
```
`src/decode.worker.ts:35` — `decode(sid,key)` 1회 = **range-fetch + laz-perf(WASM) 디코드 + pnts 빌드**. 79+ 노드의 이 작업이 **단일 워커 스레드에서 직렬화** → deep-load 시 디코드(②축)가 병목. (요청 동시성은 6으로 별개 throttle; 진짜 병목은 단일 워커.)

## 3. Best Practice 조사 (prior art — STOP 규칙)

| 라이브러리 | Vite 모듈워커 | 상태 | 평가 |
|-----------|--------------|------|------|
| workerpool | **깨짐**(importScripts) | active | ✗ |
| threads.js | webpack only | **방치(4년)** | ✗ |
| loaders.gl worker-utils | OK | active | 88kB, 생태계 peer dep — 과함 |
| **comlink 라운드로빈(손수)** | OK(현 스택) | — | **채택** |

- 프로덕션 사례: Potree(`WorkerPool` borrow/return), Cesium(워커1 + `maximumActiveTasks` 파이프라인), **Giro3D(COPC+laz-perf 같은 스택 → 손수 풀, cap=hardwareConcurrency)**.
- WASM: 워커마다 자기 laz-perf 인스턴스 필요 — **현 코드가 이미 워커 내 lazy init**(`getLazPerf`)이라, N개 워커 생성하면 각자 init. 추가 broadcast 불필요.
- 위험: ① 풀이 세션/페이징 상태를 N개로 분산 → `open`/`loadPage`/`close` **broadcast 필수**(상태동기화) ② comlink `terminate()`는 in-flight Promise 행 → 취소는 Promise.race+AbortController ③ HT 과구독 → `ceil(hwConcurrency/2)` cap 6 ④ 큐 무한증식/우선순위 역전.

출처: Potree WorkerPool.js, Cesium TaskProcessor.js, Giro3D MR!750, comlink#428, loaders.gl worker-farm, MDN Transferable.

## 4. 시도 1: 워커 풀 — **기각 (측정상 무효, revert)**

손수 라운드로빈 comlink 풀(N개 워커, open/loadPage/close broadcast)을 구현 후 측정 → **효과 없음**. `?pool=N` A/B(동일 뷰, millsite msse=8, 실 GPU):

| t | pool=1 (단일) | pool=6 |
|---|------|------|
| 12s | 966,308점 settle | 966,308점 settle |

**둘 다 966k점에 ~12s 동치.** 따라서 디코드 워커는 병목이 아니다. → 풀 코드 revert(YAGNI, circuit-breaker: 측정으로 가설 기각).

## 5. 진짜 원인 + 향후 방향

**병목 = ① 네트워크 IO (HTTP/1.1 S3 ~6 동시연결), 디코드 아님.**
- A/B 내내 `numberOfPendingRequests=6` 고정 → 콘텐츠 throttle(6)이 binding 제약. 이 6은 ADR-004에서 **의도적**(`copc-tileset.ts:35-44`): *S3 등 HTTP/1.1 range 소스는 >6이면 8s 타임아웃·재시도 폭풍(측정)*. → throttle 단순 상향도 답 아님(HTTP/1.1 S3엔 위험).
- 부수 발견 → **해결됨(벤치)**: "millsite 25s 미settle"은 측정 결함이었다 — `numberOfTilesProcessing`이 0으로 안 떨어져 settle 판정 실패. `scripts/compare-eptium.ts` settle 조건에서 `processing===0`을 제거(`pending===0 && tilesReady 안정`만)해 우회. 재측정: 실제 settle **~14.6s**(diag) / 16.4s(bench run) — 이전 거짓 25s. 단 *왜* processing이 13에 영구 고착하는지(무한 대기/누수 vs benign)는 별도 → **이슈 #03**.

**잔여 격차(Eptium 1.49M/7.3s ≈ 15타일/s vs ours 966k/12s ≈ 6.5타일/s, ~2.3×):** 같은 S3·같은 ~6연결인데 Eptium이 타일당 더 빠름. 추정: 우리 **SW 파이프라인 오버헤드**(Cesium→SW→page→worker→S3→역경로) 또는 요청 효율. → v2 방향: ① SW 경로 per-tile 레이턴시 프로파일(DevTools), ② Eptium의 fetch 청크/CDN(HTTP/2) 여부 조사, ③ 벤치 settle 메트릭 수정 후 재측정.

**Status: 워커풀 기각·revert. 원인=네트워크 IO로 재특정. 깊은 IO 프로파일은 별도(다음 세션).**

## 6. 깊은 IO 프로파일 (2026-06-18, 실 GPU M4 Pro) — 근본원인 규명 완료

매칭 비교(§FINDINGS v4)에서 확인된 유일 실측 약점(같은 디테일 ours 16s vs Eptium 4s, ~4×)을 per-tile 분해.
계측: 워커에 per-decode 타이밍 + S3 resource timing(`getProfile`/`copcProfile`), `scripts/bench/profile-io.ts`·`eptium-net.ts`.

### 측정 (millsite msse=8, 712k, 57타일)

| 구간 | 값 | 해석 |
|------|-----|------|
| settle wall-clock | 15.6s | |
| **buildMs/tile** (pnts 빌드) | p50 **0.7ms** (Σ 38ms) | **무시 가능** |
| **decodeMs/tile** (S3 fetch+laz+reproject) | p50 **1278ms** | 거의 전부 fetch |
| S3 range 요청 수 | **61개** | |
| fetch dur/req | p50 1192ms | TTFB 지배 |
| 달성 동시성 | 6 (cap 포화) | |

→ **시간의 ~99%가 S3 range fetch. laz 디코드·pnts 빌드는 <1%.** (워커풀이 무효였던 이유 — 디코드가 병목이 아님.)

### Raw S3 지연 (curl, 브라우저·우리 코드 밖)

단일 range GET: **time_total ~0.8s, TTFB ~0.65s, HTTP/1.1, 206.** → 요청당 ~0.65s TTFB는 **S3 고유 지연**(우리 오버헤드 아님). 6 병렬 ~1.0s(동시성 정상).

### 동시성 레버 — 측정으로 **기각** (ADR-004 재확인)

`?maxReq` 를 fromUrl per-host throttle 에 배선해 스윕:

| maxReq | settle | 달성 동시성 | 재시도 | Σ-dur |
|--------|--------|------|------|------|
| 6 | 16.2s | 6 | 0 | 79s |
| 12 | 15.4s | 12 | 0 | 149s |
| 18 | 17.7s | 18 | 1 | 239s |
| 24 | 19.9s | 24 | 12 | 327s |

throttle 상향은 settle 미개선(12에서 noise, 18/24 악화) + Σ-dur 비례 폭증(가짜 동시성=브라우저 큐) + 8s 타임아웃 폭풍(재시도 12). **브라우저 HTTP/1.1 s3.amazonaws.com 6연결이 진짜 천장.** ADR-004 의 throttle=6 이 옳음 — 재확인.

### Eptium 비교 (CDP, 같은 S3 URL)

| | ours | eptium |
|--|------|--------|
| S3 요청 수 | **61** | **27** |
| 요청당 real time | ~1.3s | ~0.9s |
| 총 transfer-work | 61×1.3=79s | 27×0.9=24s |
| ÷6 동시성 | ~13s | ~4s |

**격차의 본질 = round-trip 개수(61 vs 27, 2.3×) × 각 요청 TTFB(~0.65s 고정비).** 동시성·디코드 아님. 우리는 COPC 노드마다 개별 range fetch(copc.js per-node `loadPointDataView`) + 빈노드 13개 fetch + 속성 probe 중복 + 재시도. Eptium 은 인접 노드를 **적은·큰 range 로 coalesce**.

### 근본원인 (확정)

**deep-load 시간 = (S3 range round-trip 수) × (~0.65s TTFB 고정비) ÷ (HTTP/1.1 S3 6연결).** 동시성은 이미 천장(6, 상향 불가). 디코드는 무시 가능. → **유일 레버 = round-trip 수 감소(range 요청 coalescing)**.

### 향후 수정 (STOP-게이트 — 스트리밍/IO, 계획+승인 필요)

- **range coalescing**: 인접/연속 COPC 노드 point-data 를 적은 수의 큰 range GET 으로 병합. (저이득) 속성 probe 중복-decode 제거, 빈노드 13개는 필터 후에야 알 수 있어 불가피.

### 7. coalescing 실현가능성 조사 (2026-06-18) — **강한 GO 신호**

**기술적 가능: ○.** copc.js 가 primitive 제공 — `Hierarchy.Node{pointDataOffset,pointDataLength}`(노드 byte 위치) + `decompressChunk(buf, meta, lazPerf)`(내가 직접 fetch 한 raw 버퍼에서 노드 청크 디코드). 즉 인접 노드를 한 range 로 fetch → 슬라이스 → 개별 decode 가능. (S3 는 multi-range GET 미지원이라 **연속 range 병합** 방식.)

**이득: 큼 (측정 — `scripts/bench/coalesce-feasibility.ts`).** millsite 얕은 노드(레벨 0~3, 104개) point-data 가 파일 끝 **17.3MB 구간에 거의 완벽 연속**:

| gap 임계 | 병합 range | gap 낭비 | round-trip |
|------|------|------|------|
| 0KB(완전인접) | 10 | 0% | 104→10 (10.4×) |
| 64KB | 4 | 0.7% | 104→4 (26×) |
| 256KB | 3 | 1.7% | 104→3 (35×) |

→ 현재 ~57 요청을 **3~4 range** 로(낭비 <2%). 같은 16MB 를 받되 round-trip TTFB 고정비(~0.65s×개수) 거의 제거 → deep-load 가 Eptium(4s) 수준 이하로 떨어질 여지.

**구현 방향(설계 시):** 서브페이지 paging 과 정합 — 서브페이지 로드 시 그 노드들의 연속 point-data range 를 **한 번에 prefetch → 워커 캐시 → 각 노드는 캐시에서 `decompressChunk`**. (Cesium 의 노드별 요청은 캐시 히트.) prior art: COG/GeoParquet 리더의 **range 병합/read-ahead**(GDAL CPL_VSIL_CURL merge, fsspec) = 클라우드 최적 포맷 표준 기법.

**위험/엣지(설계서에서 다룰 것):** 병합 버퍼 메모리 상한·축출(이슈 #04 LRU 영역과 정합), `decompressChunk` per-node 정확성(청크 메타=헤더 PDRF/length), 빈노드(#03)·속성 batch(속성충실도) 경로 정합, 큰 range 의 retry/timeout(8s 는 16MB 전송에 충분한가 측정), 비연속 깊은 노드(레벨>3)는 이득 작을 수 있음(측정 필요).

**Status: 근본원인 규명 완료 + coalescing 실현가능성 GO 신호(측정). 구현은 brainstorm→설계→계획(STOP)으로 별도.**

## 8. coalescing 측정 (구현 후, 2026-06-18)

골든파일(per-node vs coalesced byte-identical, 5노드): **전부 통과.**
millsite msse=8, 712k점(tilesReady=57) — 실 S3, 실 GPU M4 Pro.

| 항목 | coalesce ON (기본) | coalesce OFF (폴백) | 기준 |
|------|------|------|------|
| S3 range 요청 수 | **6** | 61 | ≤15 **✓** |
| settle wall-clock | **4823ms** | 13892ms | <8000ms **✓** |
| pointsSelected | 712458 | 712458 | 동일 ✓ (정확성 회귀 없음) |
| 재시도 | 0 | 0 | — |

coalescing 으로 round-trip 61→6(10×↓), settle 13892→4823ms(2.9×↓). **검증기준 2·3 모두 충족.**
Eptium(4s) 대비 4823ms ≈ 동급. 정확성 동일(같은 712k점).
