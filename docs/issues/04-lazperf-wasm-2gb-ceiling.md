# #04 coalescing in-flight/rebuild 레이스 → 잘린 바이트 슬라이스 (증상: laz-perf WASM 2GB abort)

Status: In Progress · Label: bug (correctness, #02 coalescing 회귀)
발견 경로: sofi(1.9GB) 무거운 예제 Eptium 대조 테스트(2026-06-18). msse=4 극단 refine서 표면화.
재현 하니스: `scripts/bench/repro-04.ts [msse] [coalesce]` (워커 laz-perf heap 궤적 + 슬라이스 범위초과 카운트).

> **정정:** 최초 등록은 "laz-perf WASM 2GB 천장(볼륨 한계)"로 봤으나, 측정으로 **coalescing 정확성 버그**로 확정. WASM abort 는 *증상*이고 근본은 coalescing in-flight dedup 레이스다. STOP 게이트(동시성/캐싱) — measure-first 로 근본 규명 후 fix.

## 1. 문제 (재현 — RED 확인)

sofi(1.9GB)를 **msse=4**로 극단 refine(~4.2M점, 186 디코드)하면 coalesce **ON**에서:

```
WASM abort: YES  (asked to go up to 3,552,198,656 bytes, limit 2,147,483,648)
500 에러: 2    coalesce 슬라이스 범위초과: 2
heap 궤적: #0~#90 = 7.1MB(고정) → #100(node 4-4-4-1) 디코드서 7.1→1877.4MB 단일 점프 → 직후 alloc 2GB 돌파 abort
범인 디코드 #100 key=4-4-4-1 nodePts=21,743 (1.8MB짜리인데) decodeMs=3383ms heap +1870MB
```

**coalesce OFF 는 멀쩡:** 동일(오히려 더 무거운) msse=4 부하(4.29M점·188디코드·64s **완주**)에서 heap **7.1MB 고정·abort 0·500 0·범위초과 0**. → 볼륨/laz-perf 천장이 아니라 **coalesce 경로 한정 결함**.

재현: `tsx scripts/bench/repro-04.ts 4` → `WASM abort: YES, 슬라이스 범위초과 2` (RED). `tsx scripts/bench/repro-04.ts 4 0`(OFF) → 전부 0 (GREEN baseline).

## 2. 원인 분석 (근본, 측정 확정)

진단 로그가 잘린 슬라이스를 정확히 포착:

```
슬라이스 범위초과 node[1966827100,1967373084) run[1966342393,1967857781) region.len=484707 → 잘린 바이트
```

- 요청 노드 4-4-4-1 = `[1966827100, 1967373084)` (len 545,984).
- 슬라이스에 쓰인 run = `[1966342393, 1967857781)` (len 1,515,388) — **rebuild 로 확장된** run.
- 그런데 in-flight 가 돌려준 실제 region.len = **484,707** = 옛 run `[1966342393, 1966827100)` (노드 시작점에서 정확히 끝남).
- `region.slice(begin−run.start, end−run.start)` = `slice(484707, 1030691)` 인데 region 길이가 484,707 → **빈 Uint8Array** 반환.
- 빈/garbage 압축 바이트 → laz-perf `ChunkDecoder.open` 이 bogus 청크 헤더를 읽어 **내부 ~1.87GB alloc** → WASM heap 폭증 → 다음 alloc 이 2GB 초과 → `Aborted` → 그 타일 500.

**메커니즘 (코드: `src/copc-core.ts` `createCoalescingGetter`):**
1. `inflight` 가 **`run.start` 만으로 키잉**(line 385,413) — run 신원(start+end)이 아님.
2. 서브페이지 lazy 로드(#03/#05 paging)로 `getNodes().length` 가 바뀌면 `rebuild`(line 406)가 run 경계 재계산. 인접 노드가 추가되면 **같은 start, 더 큰 end** 로 run 이 확장된다.
3. 확장된 run 의 노드를 요청하면 `inflight.get(run.start)` 가 **옛(작은) run 의 promise**(region=[start, 옛end))를 재사용.
4. 그 region 을 **새(큰) run 의 offset**으로 슬라이스 → region 범위 밖 → 빈/잘린 바이트.

즉 **rebuild-중-inflight 동시성 레이스**. golden-file(5노드 순차·count 불변)·msse=8 A/B(가벼움·rebuild-중-inflight 희박)는 못 잡았다 — 그래서 #02 가 머지됐다. `cache.lookup` 은 region **자신의** start/end 로 검사·슬라이스(line 441,444)라 안전 — 결함은 in-flight 경로 한정.

**영향:** 무거운 동시 로드(깊은 옥트리·다수 서브페이지)에서 일부 노드가 빈/잘린 바이트를 받아 (a) laz-perf WASM 폭증→abort→타일 500(관측), 또는 (b) 운 나쁘면 garbage 가 abort 없이 디코드돼 **조용히 잘못된 점**([[no-silent-failures]] 위반 잠재). 정상영역(msse≥8)은 미관측이나 동일 클래스 레이스라 안전 단정 불가 → 수정 대상.

## 3. Best Practice 조사 (deep-research-agent)

**single-flight 계약** (Go `golang.org/x/sync/singleflight`): dedup 키는 **결과(work)를 유일하게 식별**해야 한다 — 즉 fetch 한 **불변 byte-range 정체성 [start,end)**. 키가 결과를 유일 식별 못 하면 "in-flight 응답이 잘못된 키에 묶이는" 실패(동형 사례 [n8n #22123](https://github.com/n8n-io/n8n/issues/22123): *in-flight 는 초기화 시점의 불변 파라미터로 식별해야지, 변하는 앱 상태로 재매핑 금지*). 우리 `run.start` 가 바로 그 "변하는 상태".

**프로덕션 매핑 — 전부 fetched [offset,len) 정체성 기준 + containment 검사:**
| 구현 | 패턴 |
|------|------|
| **Apache Arrow `ReadRangeCache`** ([caching.cc](https://github.com/apache/arrow/blob/main/cpp/src/arrow/io/caching.cc)) | `lower_bound`(fetched range 의 end 로 인덱스) → `entry.range.Contains(range)` 검사 → `SliceBuffer(buf, range.offset − entry.range.offset, len)`. 슬라이스 오프셋이 **fetched entry 의 실제 start 기준**. ← 우리 fix 와 동일 |
| **fsspec `merge_offset_ranges`** ([utils](https://filesystem-spec.readthedocs.io/en/latest/_modules/fsspec/utils.html)) | grouping 을 **고정 입력에 1회 스냅샷**, mid-flight 재그룹 안 함 → 레이스 자체가 없음 |
| **GDAL `/vsicurl`** | chunk-aligned(16KB) **offset 키** 캐시 → fetched 정체성 불변 |

**채택 — C+B (Arrow 패턴):** (C) in-flight promise 를 **fetch 한 region 의 실제 [start,end) 에 바인딩**, 그 기준으로 슬라이스(`begin − region.start`). (B) 슬라이스 전 **region 이 [begin,end) 를 덮는지 검사**, 미달이면 `base(begin,end)` 직접 폴백(정확성 우선). → in-flight 경로가 이미-정확한 cache.lookup 경로와 **동일한 슬라이싱 규칙**이 됨. (A) start+end 키잉은 단독 시 rebuild 마다 겹치는 run 중복 fetch(대역폭 낭비)라 채택 X. 깊은 불변식: *fetched region 정체성은 불변 — mutable grouping 이 슬라이스를 결정하게 두지 말 것.*

## 4. 수정 (`src/copc-core.ts` `createCoalescingGetter`)

| 변경 | 내용 |
|------|------|
| `inflight` 타입 | `Map<number, Promise<Uint8Array>>` → `Map<number, Promise<CachedRegion>>` (fetch 한 `{start,end,bytes}`) |
| fetch | `base(run.start, run.end)` → `base(rStart, rEnd).then(bytes => ({start:rStart, end:rEnd, bytes}))` (run 경계 스냅샷) |
| insert | `cache.insert(run.start, run.end, b)` → `cache.insert(region.start, region.end, region.bytes)` (fetch 정체성) |
| 슬라이스 | `return region.slice(begin−run.start, end−run.start)` → 커버리지 검사 후 `region.bytes.slice(begin−region.start, …)`, **미달 시 `base(begin,end)` 폴백** |

```ts
// after (핵심)
const region = await p; // { start, end, bytes } — fetch 한 실제 정체성
if (region.start <= begin && region.end >= end) {
  return region.bytes.slice(begin - region.start, end - region.start);
}
return base(begin, end); // 레이스: in-flight region 이 이 노드를 안 덮음 → 직접 정확 fetch
```

## 5. 검증 (RED→GREEN + 회귀 0)

| 검증 | 수정 前 (RED) | 수정 後 (GREEN) |
|------|------|------|
| `repro-04 4` (sofi msse=4 ON) | WASM abort YES · 500×2 · 슬라이스 범위초과 2 · heap 7→**1877MB** · 4.21M 에서 정지 | abort **0** · 500 **0** · 범위초과 **0** · heap **7.1MB 고정** · **완주 4,291,095점**(=OFF 동일) |
| coalescing 이득(`profile-io sofi 8`) | round-trip 10 · 1,046,325점 | round-trip **10**(불변) · 1,046,325점(불변) — 폴백은 레이스 노드만 |
| 골든파일 byte-identical(5노드) | pass | **pass** |
| 단위 `check-coalesce` Task 7(#04 레이스) | (신규) 노드 B 빈 배열 → FAIL | **PASS**(byte-identical) |
| `build`·`verify` C1(autzen)·`repro-03`(#03) | — | 전부 **PASS** |

재현 하니스: `scripts/bench/repro-04.ts`(브라우저 통합) + `scripts/check-coalesce.ts` Task 7(단위·결정적). 워커 `decodeProfile` 에 `heapMB`/`nodePts` 계측 추가(repro-04 가 사용).

**판정: PASS — Status In Progress → Resolved 후보.** `/issue-track close #04` 안내 대상.

**독립 리뷰(Codex, 적대):** 정확성 **CLEAN** — C+B 수정이 원래 stale-slice 레이스를 완전 차단, 단위테스트도 진짜 버그 재현(tautology 아님) 확인. 발견 1건은 **성능 엣지(정확성 무관)**:

**잔여(known follow-up, 미착수):** 폴백 `base(begin,end)` 는 dedup·캐시를 안 한다 → run 이 커지는 레이스 순간 그 확장 구역 노드들이 **동시에 직접 fetch** 를 낼 수 있음(redundant). 정확성 무관·브라우저 6연결/host 로 bound·실측 미관측(수정 후 msse=8 round-trip 10 불변)이라 **코드 추가 보류**(방금 고친 동시성 경로에 반사적 추가 금지 — circuit-breaker). 동시 부하서 폴백 빈도가 문제되면 그때 `[begin,end)` single-flight 로 dedup. (BP 도 "선택적 mitigation" 으로 분류.)

---
범위 메모: #02 coalescing(머지됨)의 잠복 정확성 회귀를 측정으로 규명·수정. "WASM 천장"이 아니라 in-flight/rebuild 레이스였음. 정상영역(msse≥8)은 무영향이었으나 동일 클래스 레이스라 fix 로 구조적 차단.
