# #14 deep-load 8초 fetch 타임아웃 brittle — 느린 네트워크서 재시도 폭풍

**Issue**: #14 (개발 이력 — 비공개 트래커)
**Status**: **measuring** (dual-review 2라운드 BLOCKED → circuit-breaker → 측정 결과 idle 타임아웃은 *틀린 레버*로 판명, 레버 재선택 중)
**Created**: 2026-06-20
**Resolved**: -

---

## 0. 측정으로 뒤집힌 근본원인 (2026-06-22, dual-review 후속)

idle-타임아웃 수정(§4)이 dual-review 2라운드에서 BLOCKED(circuit-breaker 발동). 핵심 의문: "brittle의 실제
병목이 body throughput인가(=idle이 맞는 레버), 아니면 pre-header(TTFB/큐)인가?" → **측정으로 확정**.

측정(`scripts/bench/measure-ttfb.ts`, 실 S3 비-throttle, concurrency=6, 노드 200표본):

| dataset | TTFB p50 | body p50 | **TTFB가 range 시간 차지** | bytes/range p50 |
|---------|----------|----------|---------------------------|-----------------|
| autzen | 228ms | 24ms | **82%** | 300KB |
| millsite | 215ms | 6ms | **88%** | 94KB |
| sofi (실제 #14) | 221ms | 15ms | **64%** | 189KB |

- **TTFB p50 ≈ 220ms 가 데이터셋 무관하게 일정** = S3 per-request 왕복(round-trip) 바닥값. range 읽기 시간의
  **64~88%가 pre-header**(헤더 도착 전: 큐+연결+서버 응답시작). body 전송은 소수(p50 6~24ms).
- S3 throttle 은 *응답시작 지연(TTFB)* 을 부풀린다 = 이미 지배적인 버킷을 더 키움. 정상망서 이미 TTFB 지배면
  throttle 시 더 심해진다(보수적 신호).
- **결론: idle 타임아웃은 body 단계(소수 12~36%)만 관장 → #14 brittle 의 진짜 레버가 아님.** 진짜 레버 후보:
  round-trip 수 감소(coalescing #02 가 이미 61→6), 동시성/연결 관리(큐 감소), pre-header 응답시작 지연에 대한
  재시도-예산/백오프. (idle 은 body-stall 이라는 *드문* 경우엔 여전히 옳지만 #14 증상의 주원인이 아님.)
- 부수 결함(dual-review 2라운드): idle absMax(30~180s)가 SW 백스톱(`public/copc-sw.js:63`, 40s, 구 8s×4 예산
  기준)과 충돌 — 진행 중 읽기를 40s에 죽여 500→Cesium 재요청(폭풍이 상위 레이어로 이동). 레버 재설계 시 SW
  백스톱과 워커 예산을 단일 출처로 정합해야 함.

→ §4 의 idle 수정은 *틀린 레버* 로 보류. 레버 재선택은 위 측정을 출발점으로.

---

## 1. 문제

### 증상
대용량 COPC(sofi 1.9GB) 깊은 로드 중 네트워크가 느려지면, 로드가 2~4배 느려지고 불완전하게 끝난다. 콘솔에 `[copc] range 재시도 … The user aborted a request` 경고가 반복(최대 8회) 출력되고, 점이 일부만 표시된다.

### 재현 조건
- 환경: sofi(1.9GB) 깊은 뷰(0.15r), 실 GPU(M4 Pro Metal). 느린/혼잡한 네트워크 또는 S3 throttle 상태.
- 단계: `npm run bench:probe-bundle` → dev 서버 → `npx tsx scripts/bench/profile-io.ts sofi 8`.

### 측정 로그 (profile-io, 실 GPU)
| 망 상태 | settle | fetch p50 | 재시도 | 점 로드 | 동시성 |
|---------|--------|-----------|--------|---------|--------|
| 정상 | 18.7s | 778ms | 1 | 1.05M (완료) | 3 |
| **느림(S3 throttle)** | **40s** | **~8000ms(전부 컷)** | **8** | **265k (25%만)** | 3 |

느린 망에선 **모든 fetch가 정확히 ~8000ms에서 중단** = 8초 타임아웃이 매 fetch를 컷 → 재시도 폭풍 → 로드 stall·불완전.

### 결정적 재현 (Node 단위, S3 무관 — `scripts/check-timeout.ts`)
"느리지만 진행 중"(청크가 꾸준히 도착)인 fetch를 mock으로 만들어 타임아웃 거동 검증 (RED):

| 시나리오 | result | attempts | 판정 |
|----------|--------|----------|------|
| A 진행중-느림(50ms/청크, 총 500ms > 타임아웃 200ms) | **rejected** | **4**(1+재시도3) | 🔴 진행 중인데 죽고 재시도 폭풍 |
| B 진짜-hang(무진행) | rejected | 4 | ✅ 정상적으로 죽음 |

→ 현재 코드는 A(느리지만 정상)와 B(hang)를 **구분 못 하고 둘 다 죽인다.** 수정 후 목표: A=resolved(attempts 1)·B=rejected 유지.

---

## 2. 원인 분석 (1차 — issue-resolve Step 2서 확정)

### 측정 데이터
위 표. 핵심: 느린 망에서 fetch 지속시간이 전부 ~8000ms(타임아웃 값)에 몰림 = 실제 S3 응답이 8초를 넘는데 우리가 8초에 강제 abort.

### 근본 원인 (가설 — 코드)
`src/copc-core.ts:25-30,42`:
- `FETCH_TIMEOUT_MS = 8000` (고정 base)
- `rangeTimeoutMs = max(8000, sizeMB × 2000)` — 크기 비례지만 **base 8초가 작은/중간 range엔 고정**.
- `signal: AbortSignal.timeout(rangeTimeoutMs(...))` — 시도마다 8초 one-shot. 8초 초과 시 abort(`The user aborted a request`).
- p-retry가 이 abort(타임아웃)를 **일시 실패로 보고 재시도**(retries:3) → 재시도도 느린 망서 또 8초 컷 → 폭풍.

**문제의 본질**: 타임아웃이 *전체 소요시간* 기준(8초)이라, **전송이 진행 중이어도(느릴 뿐) 8초에 죽인다**. "느린 fetch"(정상, 기다리면 됨)와 "hang fetch"(무진행, 죽여야 함)를 구분 못 함.

---

## 3. Best Practice 조사 (완료 — deep-research, 2026-06-20, 출처 1차)

### 핵심: body 단계는 total이 아니라 **idle/stall(무진행) 타임아웃**이 업계 표준
- **결정적 증거**: undici(Node 표준 HTTP) `bodyTimeout`이 **청크마다 `timeout.refresh()`** 호출 = idle 타이머(소스 `lib/dispatcher/client-h1.js` onBody). 공식 문서 "Monitors time *between* receiving body data". 기본 300s.
- **정확한 prior art = curl/GDAL low-speed**: `CURLOPT_LOW_SPEED_LIMIT`+`_TIME` = "N초간 평균속도 < L B/s면 abort" = *느리지만 진행 중은 살리고, 멈추면 죽임*.
- `AbortSignal.timeout`은 **total only·리셋 불가**(WHATWG dom#1082) → idle엔 **수동 AbortController 필수**.

| 클라이언트 | body 타임아웃 | 재시도 |
|------|------|------|
| undici | `bodyTimeout`=idle(청크마다 refresh) 300s | 인터셉터 |
| got | `socket`=idle(데이터 시 리셋) | 옵트인 |
| curl/GDAL | low-speed(속도<임계 N초면 abort) + `--max-time`(total 별개) | 별개 |
| AWS SDK | per-attempt 타임아웃 | 지수백오프+full jitter + retry quota 토큰버킷(폭풍 차단) |
| Azure Blob JS | `tryTimeoutInMs`=per-try(전체 아님) | maxTries 4 |

→ 합의: ① body는 idle/low-speed로 죽임(total X) ② 타임아웃 per-attempt(누적 X) ③ 폭풍은 jitter+quota.

### 엣지케이스/위험
| 시나리오 | 위험 | 대응 |
|------|------|------|
| 진짜 hang(0바이트) | idle 타이머 첫 청크 전 미시작 시 영구대기 | 요청 시점부터 idle 타이머 ON |
| 매우 느린 모바일(진행하나 느림) | idle만 쓰면 1B/s로 영원히 점유 | **절대 max cap 병행**. `AbortSignal.any([idle, timeout(max)])` |
| 동시 다수 range(herd) | 재시도 동기화 스파이크 | jitter(이미 `randomize:true`) |
| stream abort 자원정리 | reader 미해제 → 누수 | 모든 경로 `finally`서 `reader.cancel()` |
| arrayBuffer→스트림 정확성 | 청크 누락 | `done`까지 모든 Uint8Array 길이합산 후 concat |
| 단일 청크 range | idle 리셋 기회 없음 | 무해(곧 done) |

### 우리 적용 (권고)
`AbortSignal.timeout`(total) → **idle 타임아웃**(`getReader()` 루프, 청크마다 idle 타이머 리셋, 무진행 시만 abort) + **절대 max cap**(안전망, `AbortSignal.any`로 합성). idle은 진행 중이면 절대 안 죽이므로 "느린 fetch"는 살고 "hang"만 죽음 → 재시도 폭풍 소멸. 출처: undici·curl/GDAL low-speed·AWS·MDN(getReader/AbortSignal.any).

## 4. 수정 내용

### 변경 파일
| 파일 | 변경 요약 |
|------|----------|
| `src/copc-core.ts` | `AbortSignal.timeout`(total) → **idle 타임아웃**(`getReader()` 청크 루프, 청크마다 리셋) + **절대 max cap**(`absoluteMaxMs`, 안전망)을 `AbortSignal.any`로 합성. `rangeTimeoutMs`(total) 제거 → `absoluteMaxMs`(크기비례 30~180s) 신설. `FETCH_TIMEOUT_MS`→`IDLE_TIMEOUT_MS`(8s 무진행). |
| `scripts/check-timeout.ts` | 신규 결정적 재현(진행중 vs hang). |
| `scripts/check-coalesce.ts` | Task4: `rangeTimeoutMs`→`absoluteMaxMs` 단언 갱신. |

### Before / After (핵심)
```ts
// Before — total 타임아웃: 8초 안에 *끝나야* 함 → 느리지만 진행 중도 죽임
signal: AbortSignal.timeout(rangeTimeoutMs(begin, end, timeoutMs)),
return new Uint8Array(await res.arrayBuffer());

// After — idle 타임아웃: 청크 도착마다 리셋 → 진행 중이면 안 죽임(undici bodyTimeout·curl low-speed 동형)
const idleCtrl = new AbortController();
let idleTimer = armIdle(); const resetIdle = () => { clearTimeout(idleTimer); idleTimer = armIdle(); };
const signal = AbortSignal.any([idleCtrl.signal, AbortSignal.timeout(absoluteMaxMs(begin, end))]);
const reader = res.body.getReader();
for (;;) { const { done, value } = await reader.read(); if (done) break; resetIdle(); chunks.push(value); ... }
// 전바이트 보존(길이합산 후 concat) + finally reader.cancel()(자원정리)
```

### PR
(아래 §5 검증 후 생성)

## 5. 검증 결과

### 테스트 방법
- 재현(Step 1 동일): `npx tsx scripts/check-timeout.ts` — 진행중(50ms/청크) vs hang(무진행) mock.
- 회귀: `check-coalesce`·`check-retry`·`tsc`·`verify`(autzen C1)·`build`.

### 결과 (Before=현재코드 RED / After=수정 GREEN)
| 항목 | Before | After | 판정 |
|------|--------|-------|------|
| A 진행중-느림(50ms/청크) | rejected, attempts 4 (죽고 재시도 폭풍) | **resolved, attempts 1** (안 죽고 완료) | **PASS** |
| B 진짜-hang(무진행) | rejected, attempts 4 | rejected, attempts 4 (여전히 죽음) | PASS (hang 가드 유지) |
| check-coalesce | — | 전체 passed (absoluteMaxMs + 코얼레싱 무회귀) | PASS |
| check-retry (재시도/분류/타임아웃) | — | 전체 PASS | PASS |
| tsc / build | — | 통과 | PASS |
| verify (autzen C1, 실 디코드) | — | C1 PASS (center in Oregon) | PASS |

→ **느리지만 진행 중인 fetch는 안 죽고(재시도 폭풍 소멸), 진짜 hang만 죽음.** 정확성·재시도·코얼레싱 회귀 0.

### 실세계 확인 (실 GPU, S3 throttle 상태 — 오늘 sofi 반복로드로 자초)
| ds | settle | pts | 재시도 | 해석 |
|----|--------|-----|--------|------|
| millsite | 40s(cap) | 85k(진행) | **0** | 폭풍 소멸·로딩 동작(느린 S3서도 진행, 안 죽음) |
| sofi | 40s(cap) | 0 | **0** | S3 throttle로 40s 내 첫 타일 미완(단 폭풍 없음) |

**핵심: 재시도=0** (수정 전 동일 throttle서 8회 폭풍). 수정이 폭풍을 소멸시켰고 진행 중 fetch를 안 죽임을 실세계서도 확인. sofi pts=0은 **S3 환경**(자초한 throttle)이지 수정 회귀 아님(millsite 로딩 정상이 증명).

**정직**: S3 throttle로 *깨끗한 before/after 로드시간 비교*는 못 함 — 결정적 단위 테스트(RED→GREEN)가 수정의 정확성을 증명. S3 회복 후 clean 재측정은 follow-up.

### 잔여 이슈
- 권장 수치(idle 8s·absMax 30~180s)는 실측 튜닝 여지. idle 전환 자체로 brittle 해소.
- S3 회복 후 clean before/after 로드시간 재측정(폭풍 소멸의 시간 이득 정량화) — follow-up.
- coalescing 동시성 cap(ON 동시성3 vs OFF 6)은 별건(이슈 #02 연관, 본 이슈 스코프 외).

---
스코프: 타임아웃 견고성 한정. coalescing 동시성 cap(ON 동시성3 vs OFF 6, 좋은 망서 ~1.5배)은 별건(이슈 #02 연관, 보류).
