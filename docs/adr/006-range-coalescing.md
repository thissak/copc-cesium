# ADR-006: S3 range 요청 coalescing — deep-load round-trip 감소

- **상태**: Accepted (2026-06-18)
- **관련**: [ADR-004](004-delegate-memory-concurrency-to-cesium.md) ③ 동시성 throttle=6 유지 · [이슈 #02](../issues/02-deep-load-worker-pool.md) §6~8 · [이슈 #03](../issues/03-tiles-processing-stuck.md) 빈 노드 경로 · CHANGELOG 2026-06-18

## 맥락

주최사 목표어 "빠르게"의 유일 잔여 격차: **이슈 #02 §6 IO 프로파일(실 GPU M4 Pro)** 에서 millsite msse=8 deep-load(712k점, 57타일)를 분해한 결과:

| 구간 | 값 |
|------|-----|
| settle wall-clock | 15.6s |
| decodeMs/tile (S3 fetch+laz+reproject) | p50 **1278ms** — 거의 전부 fetch |
| S3 range 요청 수 | **61개** |
| laz 디코드·pnts 빌드 Σ | **38ms** (무시 가능) |

→ **시간의 ~99%가 S3 range TTFB(0.65s/req 고정비).** 레버 분석:

- **동시성 상향** — ADR-004 §보강에서 maxReq 스윕(6/12/18/24)으로 기각. S3 HTTP/1.1 호스트당 6연결이 진짜 천장; 상향하면 8s 타임아웃 폭풍.  
- **디코드 병렬화** — 이슈 #02 §4에서 워커풀 A/B(pool=1 vs 6)로 기각. 1ms 미만 차이.  
- **round-trip 수 감소** — 유일 레버. Eptium 비교(§6): 61 vs 27 range → ~4× 속도 차. Eptium이 인접 노드를 coalesce함을 CDP NetworkRequest 관찰로 확인.

**실현가능성 조사(§7, `scripts/bench/coalesce-feasibility.ts`):** millsite 얕은 노드 104개의 point-data가 파일 끝 17.3MB 구간에 거의 완벽 연속:

| gap 임계 | 병합 range | gap 낭비 | round-trip |
|------|------|------|------|
| 256KB | 3 | 1.7% | 104→3 (35×) |
| 64KB | 4 | 0.7% | 104→4 (26×) |

→ 낭비 <2%로 round-trip을 1/10 수준으로 줄일 여지. STOP 게이트(캐싱·스트리밍 primitive) 적용 → BP 조사 후 착수.

**Best Practice 근거(prior art):**

| 라이브러리/포맷 | 기법 | 비고 |
|----------------|------|------|
| GDAL `VSICURL_CACHE_SIZE` + merge | range 병합 + 슬라이딩 prefetch | COG 표준 기법 |
| fsspec `AsyncFileSystem.merge_ranges` | 인접 range를 단일 GET으로 | Python cloud IO 표준 |
| Zarr v3 consolidated metadata | chunk range prefetch | Zarr 기본 전략 |
| COPC-JS (`copc.js`) | `decompressChunk(buf, meta, lazPerf)` 노출 | **우리 스택에서 직접 사용 가능** |

COPC-JS는 `Hierarchy.Node.pointDataOffset/pointDataLength`(노드 byte 위치) + `decompressChunk`(raw 버퍼→청크 디코드)를 public API로 제공 → 인접 노드를 1개 range로 fetch → 슬라이스 → 개별 decode 가능. **COPC-JS 자체는 coalescing을 구현하지 않아 우리 구현이 novel한 조합.**

## 결정

`src/copc-core.ts`에 **캐싱 getter 데코레이터 + region LRU 캐시**를 구현해 기존 copc.js `getter`(node당 range fetch)를 교체:

### 1. `groupRuns` — two-cap run 그룹핑

인접 노드를 gap 기준 2가지 상한으로 병합:
- **`maxGap = 256KB`**: 인접 간격이 이 미만이면 병합(낭비 <2%)
- **`maxSize = 8MB`**: 단일 range 상한(8s 타임아웃 안에 안전한 크기 — 8MB/~50MB/s ≈ 0.16s)

→ 57 노드 요청이 **6 range**로 (millsite msse=8 실측).

### 2. `createRegionCache` — 총바이트 LRU region 캐시

fetch된 ArrayBuffer를 `(offset,length)` 키로 캐시. 전략:
- 총바이트 상한 `maxBytes = 64MB` (region-LRU: 바이트 합으로 evict, 이미 사용 중인 region은 evict 유예)
- 슬라이스는 복사본 반환(원본 변형 차단)
- 캐시 히트 시 range fetch 0회

### 3. `createCoalescingGetter` — 캐싱 getter 데코레이터

point-data range 요청을 가로채 coalesced run에서 서빙:
- **run 공유**: 같은 run에 속하는 형제 노드 요청이 동시에 들어오면 **in-flight 공유** (dedup) — `Promise<ArrayBuffer>` 1개를 여러 소비자가 await
- **passthrough**: header·hierarchy·속성 probe 등 비-노드 요청은 원래 getter로 위임 (경로 정합)
- **타임아웃**: `rangeTimeoutMs` — 크기 비례 (`max(8000, size/1MB*2000)` ms; 8MB=16s)

### 4. 노브 `coalescing` (기본 `true`)

`CopcTileset.fromUrl(url, { coalesceMaxGap: 0 })` 또는 데모 `?coalesce=0` — 폴백 동작(coalescing OFF)이 원래 per-node getter와 동일함을 검증기준 6에서 확인.

## 결과

**측정 (millsite msse=8, 712k점, 57타일 — 실 S3, 실 GPU M4 Pro, 2026-06-18):**

| 항목 | coalesce ON | coalesce OFF | 기준 |
|------|------|------|------|
| S3 range 요청 수 | **6** | 61 | ≤15 ✓ |
| settle wall-clock | **4823ms** | 13892ms | <8000ms ✓ |
| pointsSelected | 712458 | 712458 | 동일 ✓ |
| 골든파일 (5노드 byte-identical) | **전부 통과** | — | — |
| Eptium TTD 비교 | 4823ms | — | Eptium ~4091ms → **동급** ✓ |

**matched-bench (2026-06-18, M4 Pro Metal, 실 GPU):**

| 지표 | ours (coalesce ON) | eptium |
|------|------|------|
| TTD | 4314ms | 4091ms (+5%) |
| frametime p95 | 9.3ms | 10.3ms |
| peakHeap | 115MB | 138MB |
| range 요청 | 3 (헤더만, 타일은 SW) | 60 |

**peakHeap 변화 (이전 베이스라인 73.6MB → 115MB, +56%):** region LRU 캐시(64MB 상한)가 coalesced buffer를 보유하는 동안 일시 증가. 단, ① 여전히 Eptium(138MB) 대비 우위, ② 64MB LRU 상한으로 무제한 증식 없음, ③ TTD 완료 후 캐시가 LRU 축출되면 복귀.

**(+)** round-trip 61→6(10×↓), settle 13.9s→4.8s(2.9×↓). Eptium 동급. 정확성 무변화(동일 712k점·골든파일 byte-identical).  
**(+)** 손코딩 캐시 primitive 1개 추가이나 COPC-JS prior art(`decompressChunk`) 기반 — STOP 규칙 충족.  
**(+)** `coalescing=false` 폴백 = per-node 동작 동일 (coalescing이 getter decorator라 분리 명확).  
**(−)** region 캐시 메모리 일시 증가(+40MB 피크, 64MB 상한). 장시간 항해 soak 측정은 미완 — 기준 5(region 캐시 상한 준수) plateau 확인 필요.  
**(−)** 비연속 깊은 노드(레벨>3)는 이득 작을 수 있음 (millsite에서는 비가시 레벨이라 미측정).
**(−→fixed, 이슈 #04)** in-flight 공유에 잠복 레이스가 있었다 — `inflight` 가 `run.start` 로만 키잉돼, 서브페이지 lazy 로드로 run 경계가 커지면(같은 start, 더 큰 end) 진행 중인 옛(작은) region 을 새 run offset 으로 슬라이스 → 빈 바이트 → laz-perf 폭증. 무거운 부하(sofi msse=4)에서 발견·수정: in-flight 정체성을 fetch 한 실제 `{start,end,bytes}` 로 고정하고 그 기준 슬라이스 + 커버리지 미달 시 `base` 폴백(Arrow `ReadRangeCache` 패턴). 교훈: **mutable grouping(run)이 in-flight 결과의 슬라이스를 정하게 두지 말 것.** ([이슈 #04](../issues/04-lazperf-wasm-2gb-ceiling.md) · `coalescing-inflight-race` 위키)

## ADR-004 · 이슈 #03 와의 관계

- **ADR-004 ③ throttle=6 유지**: coalescing은 round-trip 수를 줄이지 동시 연결 수를 늘리지 않는다. 6 range가 순차적으로 발행되고 브라우저 6/host 한도 안에서 병렬 처리됨 — throttle 상향 없이 S3 안정성 유지.
- **이슈 #03 빈 노드 경로 정합**: coalescing getter의 passthrough 조건(`isPointData`)이 빈 노드의 404 응답 경로를 건드리지 않음 — repro-03.ts 회귀 테스트로 매 실행 검증.
