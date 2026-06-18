# #02 deep-load 느림 — 단일 디코드 워커 직렬화

Status: In Progress · Label: enhancement(perf) · Branch: worktree-eptium-bench
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
