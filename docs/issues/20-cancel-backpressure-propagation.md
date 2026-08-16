# #20 취소/백프레셔 전파 부재 — 불필요해진 타일의 fetch/decode가 끝까지 점유

**Issue**: #20 (개발 이력 — 비공개 트래커)
**Status**: Closed — Won't-fix (Phase 0 게이트 FAIL: SW-signal 미발화로 클린 수정 불가 + 유계 영향 + Tier2)
**Created**: 2026-06-23
**Resolved**: 2026-06-23 (won't-fix — measure-first 결론)

---

## 1. 문제

### 증상
- 카메라 churn(빠른 줌/팬)으로 Cesium이 더 이상 필요 없다고 판단한 타일의 요청을 취소(`RequestScheduler` cancel)해도, 해당 타일의 range fetch와 laz-perf 디코드가 **끝까지 실행**된다.
- 취소된(=버려진) 타일이 제한된 동시성 슬롯(HTTP/1.1 S3 ~6 연결)과 디코드 워커를 끝까지 점유 → 정작 현재 뷰에 필요한 타일이 대기. 느린/혼잡한 네트워크에서 가중.

### 재현 조건
- 환경: 실 GPU, 대형 데이터셋(sofi 1.9GB) 깊은 뷰
- 단계: 깊은 뷰에서 빠른 카메라 이동(churn) → Cesium이 다수 타일 요청 취소 → 취소된 타일의 SW fetch / worker decode 활동이 완료까지 지속되는지 관측(네트워크/워커 계측)

### 근본 원인 가설 (코드확정 갭, 측정 전)
파이프라인 3계층이 취소 신호를 무시한다:
1. **SW**(`public/copc-sw.js`) — `e.request.signal`(`FetchEvent`의 abort 신호)을 보지 않음
2. **worker**(`src/decode.worker.ts`) — `decode()`에 abort 인자 없음, laz-perf 디코드 중간에 끊을 수단 없음
3. **copc-core fetch**(`src/copc-core.ts` `httpGetterWithRetry`) — 내부 `AbortSignal.timeout(8s)`만 있고 외부 취소 신호를 받지 않음

> ⚠️ 위는 코드 읽기 기반 가설. **재현 측정은 Step 1**, 근본원인 확정은 Step 2에서.

### 관련
- corroborate: giro3d#677 "cancel-in-flight" (critical)
- 출처: `docs/IMPROVEMENTS.md` Tier2 #4 (Codex #2 코드확정 갭)
- 열린 [#14](14-deep-load-fetch-timeout-brittle.md)(deep-load brittle)의 레버(round-trip/동시성)와 부분 연관 — 좀비 요청이 슬롯 점유
- STOP 신호어 해당(동시성·취소·재시도) → `issue-resolve` 경유, BP 조사·Acceptance Criteria·승인 게이트 적용

### 재현 테스트 (Step 1, 결정적 RED)
`scripts/check-cancel.ts` — copc-core range getter 가 "외부 취소 신호"를 받아 in-flight fetch 를 끊을 수 있는지 검증(가장 하류=가장 끊기 어려운 지점). mock fetch 로 Node 결정적.

```
$ npx tsx scripts/check-cancel.ts
FAIL  외부취소→in-flight fetch 중단: outcome=pending fetchSignalAborted=false (기대 rejected/true)
[copc] range 재시도 (시도 1, 남은 3): fetch failed
[copc] range 재시도 (시도 2, 남은 2): fetch failed
[copc] range 재시도 (시도 3, 남은 1): fetch failed
[copc] range 재시도 (시도 4, 남은 0): fetch failed
FAIL  취소 후 재시도 중단: calls=4 rejected=true (기대 calls<4)
CANCEL FAIL ❌  외부 취소가 무시됨(취소 미전파 — 이슈 #20)
exit=1
```

- **시나리오 1**: 소비자가 취소(`ext.abort()`)해도 getter 는 `pending` 유지(외부 취소 무시), fetch 가 받은 signal 은 내부 `AbortSignal.timeout` 뿐이라 `aborted=false` → 취소가 하류 fetch 까지 전파 안 됨.
- **시나리오 2**: 재시도 백오프 대기 중 취소해도 무시 → 4회까지 재시도 소진(버려진 타일의 재시도 폭풍 지속).

> SW 진입점(`e.request.signal`)·worker `decode()` 계층의 결정적 테스트는 수정(Step 4)에서 테스트 가능한 seam 을 만들며 각 red-green 으로 추가한다. 본 RED 는 취소 전파의 **종착 메커니즘**(fetch 가 끊기지 않음)을 박는다.

---

## 2. 원인 분석

### 측정 데이터
- `check-cancel.ts` 시나리오 1: 외부 취소 후 300ms 관측창에서 getter `pending`(미해소), fetch 가 받은 signal `aborted=false`.
- 시나리오 2: 외부 취소 후에도 재시도 `calls=4`(소진까지) — 취소 시점 이후 추가 시도 3회 발생.

### 근본 원인 (코드 위치 + 메커니즘)
Cesium 이 `RequestScheduler` 로 타일 XHR 을 취소(`request.cancel()` → 브라우저 fetch abort)하면, 그 abort 는 우리 SW 의 `FetchEvent.request.signal` 에 도달한다. 그러나 파이프라인 4지점이 이 신호를 *하류로 전파하지 않는다*:

1. **SW** (`public/copc-sw.js` `fetch` 핸들러, L37~80) — `e.respondWith(async ...)` 안에서 `e.request.signal` 을 **읽지 않는다**. 요청이 abort 돼도 SW 는 page 로의 `postMessage` round-trip 을 계속 await(40s 백스톱까지). 취소 신호가 우리 시스템에 들어오는 *진입점*인데 무시됨.
2. **page handler** (`src/copc-tileset.ts` `installHandler`/`messageHandler`, L124~149) — SW→page 메시지에 취소 채널이 없다. 핸들러는 `decodeTile(sid, key)` 를 끝까지 수행하고 결과를 `port.postMessage` 로 돌려보낸다(이미 버려진 응답).
3. **worker** (`src/decode.worker.ts` `decode(sid, key)`, L58~102) — comlink RPC 에 **abort 인자가 없다**. laz-perf 디코드 중간에 끊을 수단 없음 → 끝까지 디코드 후 transfer.
4. **copc-core fetch** (`src/copc-core.ts` `httpGetterWithRetry`, L32~61) — fetch 에 `AbortSignal.timeout(rangeTimeoutMs)` 만 건다. **외부 취소 signal 을 받는 인자가 없다** → 소비자가 끊고 싶어도 in-flight range fetch/재시도가 끝까지 돈다(check-cancel RED).

**결과(자원 점유)**: 취소된 타일의 SW→page→worker→S3 range fetch 전 사슬이 완주한다 — (a) **단일 디코드 워커**(comlink 직렬)를 좀비 디코드가 점유해 *필요한* 타일 디코드가 대기, (b) **브라우저 HTTP/1.1 S3 연결**(~6)을 좀비 range fetch 가 점유. 느린/혼잡 네트워크서 가중([#14](14-deep-load-fetch-timeout-brittle.md) 레버=동시성과 부분 연관).

> 참고: Cesium *측* 동시성 슬롯(`/__copc-real/` 호스트, `maxRequestsPerServer`)은 XHR abort 시 Cesium 이 해제한다. 점유가 남는 곳은 Cesium 가시성 밖인 **워커 + S3 fetch**(워커가 직접 낸 raw fetch).

---

## 3. Best Practice 조사

### 조사 항목 (deep-research + context7 + Cesium 1.142 소스 ground-truth)

**(A) Cesium 취소 사슬 — 신호는 발생한다 (로컬 소스 확인, `Build/CesiumUnminified/index.js`)**
- `Cesium3DTile.prototype.cancelRequests()`(L153156) → 각 `request.cancel()`. out-of-view 시 `tile.cancelRequests()` 호출(L157486).
- `RequestScheduler`(L21535) → `request.cancelFunction()` → **`xhr.abort()`**(L22411·22635). Cesium 은 타일 content 를 **XMLHttpRequest** 로 받고 취소 시 XHR 을 abort 한다.
- → 취소 신호 자체는 존재. 문제는 우리 SW 인터셉트 아키텍처에서 그 신호가 어디로 들어오느냐.

**(B) Service Worker `event.request.signal` — Chrome-only (load-bearing 리스크)**
- 페이지가 fetch 를 abort 하면 SW `FetchEvent.request.signal` 이 발화 — **단 Chrome 한정**. Firefox 미구현([Bugzilla 1394102](https://bugzilla.mozilla.org/show_bug.cgi?id=1394102) NEW, 3회 backout), 스펙도 미해결([w3c/ServiceWorker #1544](https://github.com/w3c/ServiceWorker/issues/1544), 2025-11 최신). XHR.abort() 경유는 더 불확실(검증 필요).
- 우리 아키텍처: Cesium XHR → **SW FetchEvent** → SW postMessage → page → worker. 페이지가 fetch 를 직접 내지 않으므로(SW 가 소유) **취소 진입점은 SW `event.request.signal` 뿐**. 이게 안 되면 Firefox 등에선 취소가 우리 시스템에 아예 안 들어온다.

**(C) comlink 취소 — out-of-band `cancel(jobId)` (maintainer 권장)**
- comlink 는 AbortSignal 전송 미지원([#372](https://github.com/GoogleChromeLabs/comlink/issues/372) — surma: "worker.terminate() 쓰라"). BP = 별도 `cancel(jobId)` 메서드 + 워커-로컬 cancelled 플래그/AbortController. `worker.terminate()` 는 in-flight RPC promise 를 영구 미해소([#428](https://github.com/GoogleChromeLabs/comlink/issues/428)) → emergency 전용.

**(D) WASM(laz-perf) 디코드는 중간 중단 불가**
- 동기 WASM 호출은 JS 가 중단 못 함([WebAssembly/design #712](https://github.com/WebAssembly/design/issues/712), Asyncify 무용). 단 copc.js 디코드는 **fetch → decompressChunk(JS 루프)** 라 노드 경계에서 끊을 수 있다 → BP=**디코드 시작 *전*에 cancelled 체크**(노드 단위, 포크 불필요). 점별 체크는 over-engineering.

**(E) AbortSignal 합성 + p-retry**
- `AbortSignal.any([external, AbortSignal.timeout(ms)])`(Baseline 2024) 로 외부취소+시도별 타임아웃 합성. 리스너 누수 주의(`{once:true}`/`{signal}`). **p-retry 는 `{signal}` 지원** — 외부취소로 재시도 루프 즉시 중단(이미 leak-safe). 우리 `httpGetterWithRetry` 에 외부 signal 인자만 추가하면 됨.

### 프로덕션 사례
| 프로젝트 | 취소 in-flight? | 메커니즘 | 출처 |
|---------|----------------|----------|------|
| **Cesium**(호스트) | O | `cancelRequests()`→`request.cancel()`→`cancelFunction()`→`xhr.abort()` (네트워크층까지만; 커스텀 전송 뒤는 우리 몫) | 로컬 1.142 소스 L153156·21535·22411 |
| **deck.gl** Tile3DLayer | O | 타일별 `AbortController`, `getData({signal})`, LRU evict→`tile.abort()` | tile-2d-header.ts |
| **giro3d** | 하이브리드 | `RequestQueue` 가 enqueue/dequeue/run-전 `signal.aborted` 체크(시작-전 취소) + source 가 signal 을 fetch 에 스레드. #677="churn 후 로딩 정체"=슬롯 누수 | RequestQueue.ts, [#677](https://gitlab.com/giro3d/giro3d/-/issues/677) |
| **loaders.gl** tiles | X(시작-전만) | `_getPriority()=-1` 로 out-of-view 스케줄 차단, in-flight signal 스레드 없음, 결과 폐기 | tile-3d.ts |
| **Potree** | X | per-frame 우선순위 큐 + `maxNodesLoading=4` 게이트, out-of-view 노드 재큐 중단(fetch signal 없음) | OctreeLoader.js |

**업계 지배 패턴 = "시작-전 취소"**(Potree·loaders.gl·giro3d 절반). 진짜 in-flight abort 는 deck.gl/giro3d-source 만. → 우리도 **시작-전 스킵이 최대 ROI**.

### 엣지 케이스 / 위험 요소
| 시나리오 | 위험도 | 대응 |
|---------|--------|------|
| **coalesced 공유 fetch 를 단일 소비자 취소가 죽임** | 높음(#04 재발류) | 공유 coalesced fetch 는 **abort 안 함** — 끝까지 받고 버려진 슬라이스만 드롭. 비-coalesced/단독 소비자 fetch 만 abort. (S3 재fetch 가 더 비쌈) |
| SW signal 미발화(Firefox/XHR) | 높음 | **measure-first 게이트**: 빌드 전 Chrome 에서 Cesium XHR abort→SW `event.request.signal` 발화 실측. 미발화 브라우저는 degraded(정직 문서화) |
| 취소가 완료와 레이스 | 중 | 경계에서만 `aborted` 체크, post-completion abort=no-op(멱등) |
| worker.terminate 시 comlink RPC 영구 미해소 | 중 | terminate 금지(협조적 취소만), 부득이하면 dangling promise 수동 reject([[no-silent-failures]]) |
| 세션 teardown vs in-flight decode | 중 | destroy 시 in-flight job 전부 reject·플래그맵 클리어(`releaseSession` 정합) |
| AbortSignal 리스너 누수 | 낮 | `{once:true}`+`{signal}`, settle 시 제거(p-retry 내장) |

---

## 4. 수정 내용

### Phase 0 게이트 (measure-first, 코드 수정 전 — **FAIL**)
설계의 load-bearing 전제(취소 신호가 SW `event.request.signal` 로 진입)를 빌드 전 실측. `scripts/bench/probe-sw-cancel.ts`(자가완결: Node http + Playwright Chromium, 프로덕션 무수정).

```
$ npx tsx scripts/bench/probe-sw-cancel.ts
[xhr]   client outcome=abort     SW: hasSignal=true abortedAtStart=false signalFired=false completed=false
[fetch] client outcome=rejected  SW: hasSignal=true abortedAtStart=false signalFired=false completed=false
XHR abort → SW signal 발화: NO ❌
GATE FAIL — XHR abort 가 SW 에 안 들어옴 → SW-signal 기반 설계 불가
```

- 클라이언트가 XHR/fetch 를 abort(outcome=abort/rejected)해도, 그 요청을 가로채는 SW 의 `event.request.signal` 은 **발화하지 않는다**(`signalFired=false`). abort 후 2300ms 폴링해도 불변, `completed=false`(SW 핸들러 계속 실행) → 늦은-발화 아티팩트 아님.
- SW 에 signal 객체는 **존재**하나(`hasSignal=true`) 외부 취소를 반영 못 함 — 열린 스펙 이슈 [w3c/ServiceWorker #1544](https://github.com/w3c/ServiceWorker/issues/1544)(2025-11)와 정합. Chrome 블로그가 말한 발화는 `respondWith(fetch(event.request))` **passthrough** 한정으로 보이며, 우리처럼 postMessage→page 로 우회하는 경로엔 적용 안 됨.

### 결론: 취소 신호의 진입 채널이 없다
우리 아키텍처(ADR-002, SW 인터셉트)에서 Cesium 취소가 우리 파이프라인으로 들어올 수 있는 경로:
1. **SW `event.request.signal`** — 미발화(Phase 0 실증). ❌
2. **page** — fetch 를 직접 내지 않음(SW 소유) → Cesium 취소 가시성 0. ❌
3. **Cesium 공개 API** — per-tile 취소 이벤트/훅 없음(`tileUnload`/`tileFailed`/`tileLoad`만; 취소-전-로드 노드는 어느 것도 안 fire). ❌

유일 잔여 = **Cesium 내부 monkey-patch**(`Request.cancel`/`RequestScheduler` 래핑으로 취소를 워커로 포워드) — fragile·버전결합·STOP 규칙상 정당화 약함.

### 재평가 (사용자 재결정 대기 — 계획의 "Phase 0 후 재결정")
- **A. 실해 측정 후 결정**(measure-first 정석): churn 시 좀비 디코드가 *유계*(Cesium throttle=6·워커 직렬)인지 *무계 누적*(Cesium 은 취소 시 슬롯 해제하나 SW/worker 는 계속 → 누적 가능)인지 실측 → 양성이면 won't-fix(데이터), 실해면 비-취소 완화책 재검토.
- **B. won't-fix now**: 클린 채널 차단·Tier2·throttle 로 유계. #14(idle-타임아웃 틀린 레버)·#19(decode) 선례.
- **C. fragile monkey-patch 강행**: 비권장(STOP·회귀위험).

### 변경 파일 (현재까지 = 측정 인프라만, 프로덕션 무수정)
| 파일 | 변경 요약 |
|------|----------|
| `scripts/check-cancel.ts` | getter 계층 취소 전파 결정적 RED (신규) |
| `scripts/bench/probe-sw-cancel.ts` | Phase 0 SW-signal 게이트 probe (신규) |

### PR
{재결정 후}

---

## 5. 실해 측정 + 판정 (Phase 0 FAIL 후 재평가)

### 측정 방법
`scripts/bench/repro-20.ts` — sofi(1.9GB) 깊은 뷰에서 카메라 churn 중 page 의 in-flight 디코드(`copcDecodeStats` 진단 훅, started−done)를 시계열 샘플. 가설: Cesium 은 취소 시 슬롯을 즉시 해제하나 SW/worker 는 계속 도므로 churn 시 in-flight 가 무계 누적될 수 있다 → 단조증가면 실해, 유계면 양성.

### 결과 (msse=4, churn 15s, 3패턴)
| churn 패턴 | in-flight peak | 누적 경향 | 비고 |
|-----------|---------------|----------|------|
| 적당(450ms step) | 0 | 없음(started==done) | 워커가 매 사이클 드레인 |
| 공격(60ms, 리셋) | 2 | 없음(후반 0) | flyToBoundingSphere 리셋이 zoom 무력화→캐시 재방문 |
| orbit(40ms, deep) | 1 | 없음 | headless 회전이 카메라를 데이터 밖으로→새 요청 1건 |

- **모든 패턴에서 in-flight ≤ 2**(throttle 6 미만)·motion 정지 시 즉시 0 수렴 → 워커(+S3 6동시·content-host throttle 6)가 realistic churn 을 따라잡음. 좀비 누적 미관측.
- **하니스 한계(정직)**: headless(swiftshader)서 *새 영역을 연속 훑는* 지속 churn 을 안정 생성 못 함(3패턴 모두 캐시 재방문/카메라 이탈로 새 요청 정체). 따라서 **이론적 최악(고해상 새 영역 빠른 traversal 이 워커 드레인율 초과)** 은 미실증. 단 그 경우도 throttle 로 유계·motion 정지 시 self-heal.

### 판정: WON'T-FIX (Blocked + bounded + Tier2)
1. **결정적 차단(Phase 0)**: 우리 SW-인터셉트 아키텍처에 Cesium 취소 신호의 진입점이 없다(SW `event.request.signal` 미발화 실증). 클린 수정 불가 — fragile Cesium-내부 monkey-patch 만 가능(STOP 규칙·회귀위험상 비정당).
2. **유계 영향**: realistic churn 에서 in-flight ≤2·self-heal → 실해 미관측(이론 최악만 미실증, 그조차 throttle 로 유계).
3. **Tier2 비헤드라인**: IMPROVEMENTS 가 "완성도·헤드라인 차별화 약함"으로 분류. [[completeness-gaps-vs-perf-measure]]·[[optimize-to-the-extreme]] 정합 — measure-first 가 *fragile 저가치 코드*를 차단(#14 idle-타임아웃·#19 decode·#05 선례).

**재개 조건**: (a) Cesium 이 SW-가시 취소 채널을 제공하거나, (b) 헤드 실 GPU 에서 새-영역 지속 churn 이 무계 누적·실 UX 저하를 *실증*하면 비-취소 완화책(워커 큐 유계화→503 재요청) 재검토.

### 잔여 이슈
- 진단 훅 `copcDecodeStats`(`copc-tileset.ts`)는 측정 인프라로 유지(`copcNodeCount`/`copcProfile` 선례) — 재개 시 재사용.
- `scripts/check-cancel.ts`(getter RED)·`scripts/bench/probe-sw-cancel.ts`(게이트)·`scripts/bench/repro-20.ts`(영향)는 won't-fix 근거 데이터로 보존.
