# COPC range coalescing 설계서 (이슈 #02)

> 2026-06-18 · 브랜치 `worktree-issue-02-io-profile` · 근거: `docs/issues/02-deep-load-worker-pool.md` §6-7

## 목표

deep-load의 S3 range round-trip 수를 줄여 로드 시간을 단축한다. 인접한 COPC 노드 point-data를 연속 단일 range GET으로 병합(coalesce)하고 캐시한다. 측정상 millsite msse=8 deep-load의 ~61 요청을 ≤15로, settle ~16s를 <8s로(Eptium ~4-5s 근접) 줄이는 것이 목표.

## 맥락 (측정된 근본원인)

- deep-load 시간의 **~99%가 S3 range fetch**(laz 디코드·pnts 빌드 <1%). 워커풀이 무효였던 이유.
- 단일 S3 range GET ~0.8s(TTFB ~0.65s 지배, HTTP/1.1). 동시성은 브라우저 host당 6연결이 천장(상향 시 가짜 동시성+타임아웃 폭풍 — ADR-004 재확인).
- **격차 본질 = round-trip 개수**: 우리 61 vs Eptium 27(같은 S3 파일). 우리는 copc.js per-node 읽기, Eptium은 coalesce.
- 얕은 노드(레벨 0-3, 104개) point-data가 파일 끝 17.3MB에 거의 연속 → 256KB gap 병합 시 **3 range, 낭비 1.7%**(`scripts/bench/coalesce-feasibility.ts` 측정).

## Best Practice (조사 결과, 출처: `docs/issues/02-...` §7 / deep-research)

- **production 표준 패턴**: region 블록 캐시(LRU, 총바이트 기준) + 인접 range 병합, 단 **두 절대 cap(`max_gap` AND `max_merged_size`) 둘 다 충족 시에만** 병합. GDAL `/vsicurl`·fsspec/kerchunk·Zarr 셋 다 동일.
- **S3는 multi-range GET 미지원** — `Range: a-b,c-d` → Range 무시·200+전체 반환. "적은 요청" = 연속 단일 range를 더 크게.
- **COPC 생태계(copc.js·PDAL·Potree)는 coalescing 미사용**(동시성만) → 이게 Eptium의 레버이자 우리에겐 **novel 최적화**.
- 권고 임계: `max_gap` 256KB(우리 측정 일치, fsspec 64KB~Zarr 1MiB 사이), `max_merged_size` 8MB(AWS "전형적 byte-range 8-16MB" sweet spot), region-LRU ~64MB, 동시성 ~6 유지.
- **정확성 함정**: COPC는 청크의 octree-순 저장을 보장 안 함 → 반드시 **실제 byte offset 정렬** 후 병합.

## 아키텍처 — 캐싱 getter 데코레이터 (decode 경로 무변경)

coalescing은 copc.js의 `Getter`(`(begin:number, end:number) => Promise<Uint8Array>`) 인터페이스를 감싸는 **데코레이터 하나**에 격리한다. `decodeNode`·`decompressChunk`·View 빌드·빈노드(#03)·속성 probe 경로는 **전부 무변경** — `loadPointDataView`가 노드 바이트를 요청할 때 그 getter가 캐시/병합으로 응답할 뿐이다.

워커 세션만 이 getter를 쓴다(페이지 세션은 point를 안 읽음). 노드 range 집합은 `session.nodes`(loadSubPage가 갱신)에서 lazy 조회한다.

```
worker.decode(key)
  → decodeNode(session, key)            [무변경]
    → loadPointDataView(getter, node)   [copc.js, 무변경]
      → getter(node.off, node.off+node.len)   ← CoalescingGetter 가 가로챔
```

## 병합 알고리즘 + region 캐시

### Run 그룹핑 (결정적, two-cap)
`session.nodes`의 point-data range를 **실제 offset으로 정렬** → greedy 1-pass로 run 묶음. 새 run 시작: `다음.offset − 현재run끝 > maxGap` **또는** `다음.end − run시작 > maxMergedBytes`. 노드→run 매핑을 캐시하고, 노드 수가 바뀔 때(서브페이지 로드)만 재계산(정렬+선형, 수백 노드라 저렴). 결정적이므로 run 간 중복 없음.

### getter(begin, end) 흐름
1. **point 읽기 판별**: `[begin,end)`가 어떤 노드의 정확한 `[off, off+len)`와 일치할 때만 point 읽기로 보고 coalesce. 불일치(헤더/hierarchy 등) → base getter 통과. (정확 일치만 보므로 비-노드 읽기를 잘못 병합할 여지 없음.)
2. begin 포함 run을 찾아 **캐시 히트면 슬라이스(복사본) 반환** (fetch 0).
3. 그 run fetch가 **in-flight면 그 promise await**(중복 fetch 방지).
4. 아니면 base getter로 run `[start,end)` **한 번 GET** → region-LRU 등록 → 슬라이스 반환.

### in-flight 중복 제거 (필수)
Cesium throttle 6으로 같은 run의 형제 노드 6개를 동시 요청하면, dedup 없이는 같은 run을 6번 fetch해 coalescing이 무효. → run별 in-flight promise 맵으로 공유(속성충실도의 `attrSpecsPromise`·BP의 GDAL/fsspec와 동일 패턴). settle(성공/실패) 시 엔트리 제거.

### region-LRU 캐시
완료 region을 `{start, end, bytes, lastUsed}`로 보관. **총 바이트 상한(기본 64MB)** 초과 시 LRU 축출. 히트 시 lastUsed 갱신. 워커 세션별(close 시 정리). 슬라이스는 **복사본**(subarray 아님) → 축출이 사용 중 데이터 미오염.

## 정확성 · 통합

- **offset 정렬 필수**(octree 순 가정 금지 = 전 노드 슬라이스 오염 버그 회피).
- **슬라이스**: `region.bytes[node.off − region.start : … + node.len]`. 골든파일 테스트로 off-by-one 가드.
- **빈노드 #03**: bytes 출처만 캐시 region으로 바뀜 → decodeNode count=0 → null → 404 → Empty 콘텐츠. 무변경.
- **속성충실도**: probe·real decode 모두 getter 경유 → 캐시 히트(중복 fetch 제거 부수이득). batch table 무변경.
- **서브페이지 paging**: loadSubPage가 nodes 추가 → run 재계산. getter는 session.nodes lazy 조회.
- **헤더/hierarchy**: passthrough(병합 안 함, 일회성).

## 에러 처리 · 위험

- **원자적 재시도**: run GET은 `httpGetterWithRetry`(p-retry) 경유 — 실패 시 run 전체 재fetch. 8MB cap이라 재시도 저렴.
- **크기 비례 타임아웃**: 고정 8s는 큰 run엔 짧을 수 있음 → 바이트 비례 `timeoutMs = max(8000, ceil(bytes/1MB) * 2000)`(8MB run → 16s; ~0.5MB/s 최저대역 가정). `httpGetterWithRetry`에 per-호출 타임아웃 인자로 전달.
- **단일 range만**: run당 연속 `[start,end)` 한 번(multi-range 금지). 206 아닌 200 응답이면 에러 표면화.
- **scattered 노드**: maxGap cap → byte-이웃 없는 노드 = run of 1(per-node fetch, graceful 폴백).
- **off 폴백**: `coalesce=0` → passthrough = 현 per-node 동작.

## 공개 API / 노브

`CopcTilesetOptions`에 추가(전부 선택, 기본값 = 켜짐):
- `coalesceMaxGap?: number` (기본 256*1024) — run 병합 gap 상한(바이트). `0` 이하면 coalescing off.
- `coalesceMaxBytes?: number` (기본 8*1024*1024) — run당 최대 병합 크기.
- `coalesceCacheBytes?: number` (기본 64*1024*1024) — region 캐시 총바이트 상한.

데모/벤치: `?coalesce=0`으로 off(A/B). fromUrl → worker `open` 옵션으로 전달.

## 파일 구조

| 파일 | 변경 |
|------|------|
| `src/copc-core.ts` | 신규 `createCoalescingGetter(base, getNodes, opts)`(run 그룹핑·region-LRU·in-flight dedup). `openCopc(url, {coalesce})` 옵션. `httpGetterWithRetry` 크기비례 타임아웃 인자. |
| `src/decode.worker.ts` | 워커 세션 open 시 coalesce on + 옵션 전달(`open` API 확장). |
| `src/copc-tileset.ts` | `CopcTilesetOptions` 노브 3개, fromUrl→worker.open 전달. |
| `src/main.ts` | `?coalesce` 데모 배선. |
| `scripts/bench/check-coalesce.ts` | 신규 — 골든파일 동일성 테스트(Node). |
| `docs/adr/006-range-coalescing.md` | 결정 기록. |

## 검증기준 (이진·측정)

1. **골든파일**: per-node getter vs coalescing getter 디코드 결과 **byte-identical**(≥3 노드, 빈노드 포함).
2. **round-trip**: millsite msse=8 deep-load S3 요청 수 **61 → ≤15**(`profile-io.ts` 측정).
3. **settle**: millsite msse=8 settle **~16s → <8s**(목표; Eptium ~4-5s 근접 — transfer-bound 수렴).
4. **회귀 0**: `build`·`verify` C1·#03 repro PASS·속성 체크 3종 PASS·매칭 bench 부드러움/메모리 불변(±10%).
5. **메모리**: region 캐시 총바이트 상한 준수(soak에서 plateau, 무한증식 X).
6. **off 폴백**: `coalesce=0`에서 per-node 정확성·동작 동일.

## 테스트 시나리오

- **정상**: millsite msse=8 로드 → round-trip ≤15, settle <8s, 포인트클라우드 정상 렌더(712k).
- **엣지**: 빈노드(전부 노이즈) run에 포함 → 디코드 count=0 → null → 404(정확성 유지). scattered 깊은 노드 → run of 1 폴백. region 캐시 상한 초과 soak → LRU plateau.
- **실패**: run GET 5xx → p-retry → 소진 시 표면화(조용한 실패 X). 큰 run 타임아웃 → 크기비례 타임아웃으로 회피.

## 범위 외 (YAGNI)

- 멀티파일/멀티 tileset 간 공유 캐시(세션별로 충분).
- HTTP/2 CDN 가정 최적화(데이터 소스는 사용자 결정 — 별도).
- 깊은 레벨(>3) 노드의 비연속성 특화 처리(maxGap 폴백으로 충분, 측정 후 필요시).
- 디코드 결과(pnts) 캐시(Cesium이 이미 cacheBytes로 관리 — ADR-004).
