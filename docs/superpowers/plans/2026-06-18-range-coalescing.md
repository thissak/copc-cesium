# COPC range coalescing 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 인접 COPC 노드 point-data를 연속 단일 range GET으로 병합(coalesce)+캐시하는 캐싱 getter를 추가해 deep-load round-trip 수를 줄인다.

**Architecture:** copc.js `Getter`((begin,end)=>Promise<Uint8Array>)를 감싸는 데코레이터 하나(`createCoalescingGetter`)에 모든 로직 격리 — run 그룹핑(two-cap)·region-LRU·in-flight dedup. `decodeNode`/`decompressChunk`/View 빌드/빈노드/속성 경로는 무변경(getter가 캐시·병합으로 응답할 뿐).

**Tech Stack:** TypeScript strict, copc.js(`Copc.loadPointDataView`·`Hierarchy.Node`), Web Worker(comlink), tsx 테스트 스크립트(assert 패턴, `scripts/check-*.ts`).

## Global Constraints

- 병합은 **two-cap 둘 다 충족 시에만**: `다음.off − run끝 ≤ maxGap`(기본 256*1024) **AND** `다음.end − run시작 ≤ maxBytes`(기본 8*1024*1024).
- run 그룹핑은 **실제 `pointDataOffset` 정렬**로만(octree 순 가정 금지 — 정확성).
- region 캐시는 **총 바이트 상한**(기본 64*1024*1024)으로 LRU 축출.
- 동시 같은-run 요청은 **in-flight promise 공유**(run.start 키).
- getter 반환 슬라이스는 **복사본**(`Uint8Array.prototype.slice`) — region 축출 안전.
- run당 **단일 연속 range GET만**(multi-range 금지 — S3 미지원).
- point 읽기 판별 = `[begin,end)`가 노드의 정확한 `[off, off+len)`와 일치할 때만. 불일치 → base getter passthrough.
- `coalesce` 옵션 없으면 off = 현 per-node 동작(폴백·A/B).
- TS strict, 기존 `src/copc-core.ts` 스타일. 신규 의존성 0.

---

### Task 1: `groupRuns` — two-cap run 그룹핑 (순수 함수)

**Files:**
- Modify: `src/copc-core.ts` (신규 export 추가, 파일 끝)
- Test: `scripts/check-coalesce.ts` (신규)

**Interfaces:**
- Produces:
  - `export interface ByteRange { off: number; len: number }`
  - `export interface Run { start: number; end: number }`
  - `export function groupRuns(ranges: ByteRange[], maxGap: number, maxBytes: number): Run[]` — ranges를 off 오름차순 정렬 후 two-cap greedy 그룹핑. 빈 배열 → `[]`.

- [ ] **Step 1: Write the failing test**

`scripts/check-coalesce.ts` 생성:
```ts
import { groupRuns, type ByteRange } from '../src/copc-core';

function assert(cond: boolean, msg: string) {
  if (!cond) {
    console.error('FAIL: ' + msg);
    process.exit(1);
  }
  console.log('ok: ' + msg);
}

// --- Task 1: groupRuns ---
const KB = 1024;
const MB = 1024 * 1024;

// 완전 인접 → 1 run
assert(
  JSON.stringify(groupRuns([{ off: 0, len: 100 }, { off: 100, len: 100 }], 256 * KB, 8 * MB)) ===
    JSON.stringify([{ start: 0, end: 200 }]),
  'groupRuns: 인접 2노드 → 1 run',
);
// gap > maxGap → 분리
assert(
  groupRuns([{ off: 0, len: 100 }, { off: 100 + 300 * KB, len: 100 }], 256 * KB, 8 * MB).length === 2,
  'groupRuns: gap > maxGap → 2 run',
);
// span > maxBytes → 분리
assert(
  groupRuns([{ off: 0, len: 5 * MB }, { off: 5 * MB, len: 5 * MB }], 256 * KB, 8 * MB).length === 2,
  'groupRuns: span > maxBytes → 2 run',
);
// 정렬되지 않은 입력 → off 정렬 후 그룹핑 (octree 순 가정 금지)
assert(
  JSON.stringify(groupRuns([{ off: 100, len: 100 }, { off: 0, len: 100 }], 256 * KB, 8 * MB)) ===
    JSON.stringify([{ start: 0, end: 200 }]),
  'groupRuns: 역순 입력도 off 정렬 후 1 run',
);
// 빈 배열
assert(groupRuns([], 256 * KB, 8 * MB).length === 0, 'groupRuns: 빈 입력 → []');
// gap 정확히 = maxGap → 병합(경계 포함)
assert(
  groupRuns([{ off: 0, len: 100 }, { off: 100 + 256 * KB, len: 100 }], 256 * KB, 8 * MB).length === 1,
  'groupRuns: gap == maxGap → 병합',
);
console.log('Task 1 passed');
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx scripts/check-coalesce.ts`
Expected: FAIL — `groupRuns`가 `src/copc-core.ts`에 없어 import 에러 (`SyntaxError: ... does not provide an export named 'groupRuns'`).

- [ ] **Step 3: Write minimal implementation**

`src/copc-core.ts` 끝에 추가:
```ts
// ── range coalescing (이슈 #02) ──
export interface ByteRange {
  off: number;
  len: number;
}
export interface Run {
  start: number;
  end: number;
}

/**
 * point-data 노드 range를 off 오름차순 정렬 후 two-cap greedy 로 run 묶음.
 * 새 run 시작: 다음.off − run끝 > maxGap (gap) 또는 다음.end − run시작 > maxBytes (size). 둘 다 만족해야 병합.
 * COPC 는 청크의 octree-순 저장을 보장 안 하므로 반드시 실제 off 로 정렬한다.
 */
export function groupRuns(ranges: ByteRange[], maxGap: number, maxBytes: number): Run[] {
  if (ranges.length === 0) return [];
  const sorted = [...ranges].sort((a, b) => a.off - b.off);
  const runs: Run[] = [];
  let start = sorted[0].off;
  let end = sorted[0].off + sorted[0].len;
  for (let i = 1; i < sorted.length; i++) {
    const r = sorted[i];
    const rEnd = r.off + r.len;
    if (r.off - end <= maxGap && rEnd - start <= maxBytes) {
      if (rEnd > end) end = rEnd; // 같은 run 확장
    } else {
      runs.push({ start, end });
      start = r.off;
      end = rEnd;
    }
  }
  runs.push({ start, end });
  return runs;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx scripts/check-coalesce.ts`
Expected: `Task 1 passed` (모든 assert ok).

- [ ] **Step 5: Commit**

```bash
git add src/copc-core.ts scripts/check-coalesce.ts
git commit -m "feat(#02): groupRuns — two-cap run 그룹핑 (range coalescing 1/N)"
```

---

### Task 2: `createRegionCache` — 총바이트 LRU 캐시 (순수)

**Files:**
- Modify: `src/copc-core.ts`
- Test: `scripts/check-coalesce.ts`

**Interfaces:**
- Produces:
  - `export interface RegionCache { lookup(begin: number, end: number): Uint8Array | undefined; insert(start: number, end: number, bytes: Uint8Array): void; }`
  - `export function createRegionCache(maxBytes: number): RegionCache` — `lookup`은 `[begin,end)`를 덮는 region이 있으면 그 슬라이스(복사본) 반환, 없으면 undefined. `insert`는 region 추가 후 총바이트 초과 시 LRU 축출. lookup 히트 시 그 region을 MRU로.

- [ ] **Step 1: Write the failing test**

`scripts/check-coalesce.ts`에 추가(`console.log('Task 1 passed')` 뒤):
```ts
import { createRegionCache } from '../src/copc-core'; // (파일 상단 import에 합치기)

// --- Task 2: createRegionCache ---
{
  const c = createRegionCache(1000);
  const region = new Uint8Array([10, 11, 12, 13, 14]); // [start=100, end=105)
  c.insert(100, 105, region);
  const hit = c.lookup(101, 104);
  assert(!!hit && hit.length === 3 && hit[0] === 11 && hit[2] === 13, 'regionCache: 덮는 lookup → 슬라이스');
  assert(c.lookup(200, 210) === undefined, 'regionCache: 미덮음 → undefined');
  // 슬라이스는 복사본 — 원본 변형 무영향
  region[1] = 99;
  assert(c.lookup(101, 104)![0] === 11, 'regionCache: 슬라이스는 복사본(원본 변형 무영향)');
  // 부분 덮음(걸침) → undefined
  assert(c.lookup(104, 110) === undefined, 'regionCache: 부분 덮음 → undefined');
}
{
  // LRU 축출: maxBytes 작게 → 오래된 region 축출
  const c = createRegionCache(10);
  c.insert(0, 6, new Uint8Array(6)); // 6B
  c.insert(10, 16, new Uint8Array(6)); // +6=12 > 10 → 첫 region 축출
  assert(c.lookup(0, 6) === undefined, 'regionCache: 총바이트 초과 → LRU 축출(오래된 것)');
  assert(!!c.lookup(10, 16), 'regionCache: 최신 region 유지');
}
{
  // lookup 으로 MRU 갱신 → 다음 축출 대상이 바뀜
  const c = createRegionCache(12);
  c.insert(0, 6, new Uint8Array(6));
  c.insert(10, 16, new Uint8Array(6)); // 12, 딱 맞음(축출 없음)
  c.lookup(0, 6); // region0 을 MRU 로
  c.insert(20, 26, new Uint8Array(6)); // 18 > 12 → LRU(region1=10-16) 축출
  assert(!!c.lookup(0, 6), 'regionCache: MRU 갱신된 region0 유지');
  assert(c.lookup(10, 16) === undefined, 'regionCache: LRU(region1) 축출');
}
console.log('Task 2 passed');
```
(상단 import를 `import { groupRuns, createRegionCache, type ByteRange } from '../src/copc-core';`로 합친다.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx scripts/check-coalesce.ts`
Expected: FAIL — `createRegionCache` export 없음.

- [ ] **Step 3: Write minimal implementation**

`src/copc-core.ts`에 추가:
```ts
export interface RegionCache {
  lookup(begin: number, end: number): Uint8Array | undefined;
  insert(start: number, end: number, bytes: Uint8Array): void;
}

interface CachedRegion {
  start: number;
  end: number;
  bytes: Uint8Array;
}

/** 총바이트 상한 LRU region 캐시. lookup 은 [begin,end)를 덮는 region 의 복사본 슬라이스 반환. */
export function createRegionCache(maxBytes: number): RegionCache {
  const regions: CachedRegion[] = []; // 뒤일수록 MRU
  let total = 0;
  return {
    lookup(begin, end) {
      for (let i = 0; i < regions.length; i++) {
        const r = regions[i];
        if (r.start <= begin && r.end >= end) {
          regions.splice(i, 1); // MRU 로 이동
          regions.push(r);
          return r.bytes.slice(begin - r.start, end - r.start); // 복사본
        }
      }
      return undefined;
    },
    insert(start, end, bytes) {
      regions.push({ start, end, bytes });
      total += bytes.length;
      while (total > maxBytes && regions.length > 1) {
        const evicted = regions.shift()!; // LRU
        total -= evicted.bytes.length;
      }
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx scripts/check-coalesce.ts`
Expected: `Task 2 passed`.

- [ ] **Step 5: Commit**

```bash
git add src/copc-core.ts scripts/check-coalesce.ts
git commit -m "feat(#02): createRegionCache — 총바이트 LRU region 캐시 (2/N)"
```

---

### Task 3: `createCoalescingGetter` — 캐싱 getter 데코레이터 (mock 통합)

**Files:**
- Modify: `src/copc-core.ts`
- Test: `scripts/check-coalesce.ts`

**Interfaces:**
- Consumes: `groupRuns`, `createRegionCache`, `ByteRange` (Task 1-2).
- Produces:
  - `export type RangeGetter = (begin: number, end: number) => Promise<Uint8Array>` (기존 로컬 `type RangeGetter`을 export로 승격)
  - `export interface CoalesceOpts { maxGap: number; maxBytes: number; cacheBytes: number }`
  - `export function createCoalescingGetter(base: RangeGetter, getNodes: () => ByteRange[], opts: CoalesceOpts): RangeGetter` — 노드 정확일치 읽기만 coalesce, 그 외 base passthrough. 노드 수 변할 때만 run/맵 재계산. in-flight 공유. 슬라이스 복사본.

- [ ] **Step 1: Write the failing test**

`scripts/check-coalesce.ts`에 추가:
```ts
import { createCoalescingGetter, type RangeGetter } from '../src/copc-core'; // 상단 import 합치기

// --- Task 3: createCoalescingGetter ---
{
  // 합성 "파일" 10MB, base getter 가 슬라이스 반환 + 호출 카운트
  const file = new Uint8Array(10 * MB);
  for (let i = 0; i < file.length; i++) file[i] = i & 0xff;
  let baseCalls = 0;
  const base: RangeGetter = async (begin, end) => {
    baseCalls++;
    return file.slice(begin, end);
  };
  // 노드 3개: 인접(같은 run)
  const nodes: ByteRange[] = [
    { off: 0, len: 1000 },
    { off: 1000, len: 1000 },
    { off: 2000, len: 1000 },
  ];
  const g = createCoalescingGetter(base, () => nodes, { maxGap: 256 * KB, maxBytes: 8 * MB, cacheBytes: 64 * MB });

  // 노드 읽기 → base 슬라이스와 byte-identical
  const a = await g(0, 1000);
  const expectA = file.slice(0, 1000);
  assert(a.length === 1000 && a.every((v, i) => v === expectA[i]), 'coalescing: 노드 읽기 byte-identical');

  // 같은 run 의 다른 노드 → 캐시 히트(base 추가 호출 0)
  const before = baseCalls;
  const b = await g(1000, 2000);
  const expectB = file.slice(1000, 2000);
  assert(b.every((v, i) => v === expectB[i]) && baseCalls === before, 'coalescing: 같은 run 형제 → 캐시 히트(base 0)');

  // base 는 run 전체를 1번만 fetch (3노드 인접 → 1 run → 1 호출)
  assert(baseCalls === 1, 'coalescing: 3 인접노드 = 1 base 호출(=1 GET)');

  // 비-노드 읽기(헤더 등, 정확일치 아님) → passthrough(base 호출)
  const headerBefore = baseCalls;
  await g(5 * MB, 5 * MB + 100); // 노드 off/len 과 불일치
  assert(baseCalls === headerBefore + 1, 'coalescing: 비-노드 읽기 → passthrough');
}
{
  // in-flight dedup: 같은 run 의 2 노드 동시 요청 → base 1번
  const file = new Uint8Array(1 * MB);
  let baseCalls = 0;
  const base: RangeGetter = async (begin, end) => {
    baseCalls++;
    await new Promise((r) => setTimeout(r, 20));
    return file.slice(begin, end);
  };
  const nodes: ByteRange[] = [{ off: 0, len: 1000 }, { off: 1000, len: 1000 }];
  const g = createCoalescingGetter(base, () => nodes, { maxGap: 256 * KB, maxBytes: 8 * MB, cacheBytes: 64 * MB });
  await Promise.all([g(0, 1000), g(1000, 2000)]); // 동시
  assert(baseCalls === 1, 'coalescing: 동시 같은-run 요청 → in-flight 공유(base 1)');
}
{
  // off=0 폴백 동작은 wiring(Task 5)에서. 여기선 maxGap 작아 분리되는지
  const file = new Uint8Array(1 * MB);
  let baseCalls = 0;
  const base: RangeGetter = async (begin, end) => {
    baseCalls++;
    return file.slice(begin, end);
  };
  const nodes: ByteRange[] = [{ off: 0, len: 100 }, { off: 100 + 300 * KB, len: 100 }];
  const g = createCoalescingGetter(base, () => nodes, { maxGap: 256 * KB, maxBytes: 8 * MB, cacheBytes: 64 * MB });
  await g(0, 100);
  await g(100 + 300 * KB, 100 + 300 * KB + 100);
  assert(baseCalls === 2, 'coalescing: gap>maxGap 인 두 노드 → 2 base 호출(병합 안 함)');
}
console.log('Task 3 passed');
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx scripts/check-coalesce.ts`
Expected: FAIL — `createCoalescingGetter`/`RangeGetter` export 없음.

- [ ] **Step 3: Write minimal implementation**

`src/copc-core.ts`에서 기존 `type RangeGetter = ...`(line ~22)를 `export type RangeGetter = ...`로 변경. 그리고 추가:
```ts
export interface CoalesceOpts {
  maxGap: number;
  maxBytes: number;
  cacheBytes: number;
}

/**
 * base getter 를 감싸 인접 노드 point-data 를 연속 range 로 병합·캐시한다(이슈 #02).
 * - point 읽기 판별: [begin,end)가 노드의 정확한 [off,off+len) 일 때만 coalesce. 그 외 base passthrough.
 * - 노드 수 변할 때만 run/맵 재계산(getNodes 는 session.nodes 에서 lazy 조회).
 * - 같은 run 동시 요청은 in-flight promise 공유(run.start 키). 슬라이스는 복사본.
 */
export function createCoalescingGetter(base: RangeGetter, getNodes: () => ByteRange[], opts: CoalesceOpts): RangeGetter {
  const cache = createRegionCache(opts.cacheBytes);
  const inflight = new Map<number, Promise<Uint8Array>>(); // run.start → region bytes
  let lastCount = -1;
  let offToLen = new Map<number, number>();
  let offToRun = new Map<number, Run>();

  function rebuild(nodes: ByteRange[]) {
    const runs = groupRuns(nodes, opts.maxGap, opts.maxBytes);
    offToLen = new Map(nodes.map((n) => [n.off, n.len]));
    offToRun = new Map();
    // 각 노드 off → 그 노드를 포함하는 run
    const sorted = [...nodes].sort((a, b) => a.off - b.off);
    let ri = 0;
    for (const n of sorted) {
      while (ri < runs.length && runs[ri].end <= n.off) ri++;
      offToRun.set(n.off, runs[ri]);
    }
    lastCount = nodes.length;
  }

  return async (begin, end) => {
    const nodes = getNodes();
    if (nodes.length !== lastCount) rebuild(nodes);
    // point 읽기(정확 노드 일치)만 coalesce
    if (offToLen.get(begin) !== end - begin) return base(begin, end);
    const run = offToRun.get(begin);
    if (!run) return base(begin, end); // 방어: run 매핑 없음
    const hit = cache.lookup(begin, end);
    if (hit) return hit;
    let p = inflight.get(run.start);
    if (!p) {
      p = base(run.start, run.end);
      inflight.set(run.start, p);
      p.then((b) => cache.insert(run.start, run.end, b)).catch(() => {}).finally(() => inflight.delete(run.start));
    }
    const region = await p; // 공유 region bytes
    return region.slice(begin - run.start, end - run.start); // 복사본
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx scripts/check-coalesce.ts`
Expected: `Task 3 passed`.

- [ ] **Step 5: Commit**

```bash
git add src/copc-core.ts scripts/check-coalesce.ts
git commit -m "feat(#02): createCoalescingGetter — 캐싱 getter 데코레이터 (3/N)"
```

---

### Task 4: 크기비례 타임아웃 — `httpGetterWithRetry`

**Files:**
- Modify: `src/copc-core.ts:26-55` (`httpGetterWithRetry`)
- Test: `scripts/check-coalesce.ts`

**Interfaces:**
- Consumes/Produces: `httpGetterWithRetry(url, fetchImpl?, baseTimeoutMs?)` 시그니처 유지. 내부에서 per-호출 타임아웃 = `Math.max(baseTimeoutMs, Math.ceil((end-begin)/(1024*1024))*2000)`. 큰 run(8MB)이 8s 고정 타임아웃에 걸리지 않게.

- [ ] **Step 1: Write the failing test**

`scripts/check-coalesce.ts`에 추가 — 타임아웃 계산을 노출된 헬퍼로 검증:
```ts
import { rangeTimeoutMs } from '../src/copc-core'; // 상단 import 합치기

// --- Task 4: 크기비례 타임아웃 ---
assert(rangeTimeoutMs(0, 100 * KB, 8000) === 8000, 'timeout: 작은 range → base 8s');
assert(rangeTimeoutMs(0, 8 * MB, 8000) === 16000, 'timeout: 8MB → 16s');
assert(rangeTimeoutMs(0, 1 * MB, 8000) === 8000, 'timeout: 1MB → max(8000, 2000)=8s');
assert(rangeTimeoutMs(0, 5 * MB, 8000) === 10000, 'timeout: 5MB → 10s');
console.log('Task 4 passed');
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx scripts/check-coalesce.ts`
Expected: FAIL — `rangeTimeoutMs` export 없음.

- [ ] **Step 3: Write minimal implementation**

`src/copc-core.ts`: `FETCH_TIMEOUT_MS` 상수 근처에 추가:
```ts
/** range 크기 비례 타임아웃 — 큰 coalesced run 이 작은-청크 타임아웃에 걸리지 않게. */
export function rangeTimeoutMs(begin: number, end: number, baseMs: number): number {
  return Math.max(baseMs, Math.ceil((end - begin) / (1024 * 1024)) * 2000);
}
```
그리고 `httpGetterWithRetry`의 `signal: AbortSignal.timeout(timeoutMs)` 부분을 수정 — 현재:
```ts
        const res = await fetchImpl(url, {
          headers: { Range: `bytes=${begin}-${end - 1}` },
          signal: AbortSignal.timeout(timeoutMs),
        });
```
을:
```ts
        const res = await fetchImpl(url, {
          headers: { Range: `bytes=${begin}-${end - 1}` },
          signal: AbortSignal.timeout(rangeTimeoutMs(begin, end, timeoutMs)),
        });
```
(파라미터 `timeoutMs`는 base 타임아웃으로 의미만 변경, 시그니처 그대로.)

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx scripts/check-coalesce.ts`
Expected: `Task 4 passed`.

회귀: `npm run verify` (C1 Oregon — httpGetterWithRetry 가 정상 동작하는지). Expected: `C1 PASS`.

- [ ] **Step 5: Commit**

```bash
git add src/copc-core.ts scripts/check-coalesce.ts
git commit -m "feat(#02): rangeTimeoutMs — 크기비례 타임아웃 (4/N)"
```

---

### Task 5: 배선 — openCopc 옵션 + 워커 open + tileset 노브 + 데모

**Files:**
- Modify: `src/copc-core.ts` (`openCopc` 시그니처)
- Modify: `src/decode.worker.ts` (`open` API)
- Modify: `src/copc-tileset.ts` (`CopcTilesetOptions` + fromUrl)
- Modify: `src/main.ts:861-867` (`runDemo` ?coalesce 배선)

**Interfaces:**
- Consumes: `createCoalescingGetter`, `CoalesceOpts` (Task 3).
- Produces:
  - `openCopc(url: string, opts?: { coalesce?: CoalesceOpts }): Promise<CopcSession>` — coalesce 있으면 session.getter 를 coalescing 으로 래핑(헤더/hierarchy 는 base 로 이미 읽음).
  - 워커 `open(sid, url, opts?: { colorBy?; hideClassifications?; attributes?; coalesce?: CoalesceOpts })`.
  - `CopcTilesetOptions`에 `coalesceMaxGap?: number`(기본 256*1024, `<=0`이면 off)·`coalesceMaxBytes?: number`(기본 8*1024*1024)·`coalesceCacheBytes?: number`(기본 64*1024*1024).

- [ ] **Step 1: openCopc 옵션 추가**

`src/copc-core.ts` `openCopc`를 수정. 현재:
```ts
export async function openCopc(url: string): Promise<CopcSession> {
  const getter = httpGetterWithRetry(url);
  const copc = await Copc.create(getter);
  const { nodes, pages } = await Copc.loadHierarchyPage(getter, copc.info.rootHierarchyPage);
  const horiz = copc.wkt ? extractHorizontalCrs(copc.wkt) : undefined;
  const toWgs = horiz ? (proj4(horiz.proj, proj4.WGS84) as unknown as Reproj) : undefined;
  return { copc, getter, nodes, pages, toWgs, zUnit: horiz ? horiz.linearUnit : 1, cube: copc.info.cube, spacing: copc.info.spacing };
}
```
을:
```ts
export async function openCopc(url: string, opts?: { coalesce?: CoalesceOpts }): Promise<CopcSession> {
  const base = httpGetterWithRetry(url);
  const copc = await Copc.create(base); // 헤더는 base 로(비-노드)
  const { nodes, pages } = await Copc.loadHierarchyPage(base, copc.info.rootHierarchyPage); // 루트 hierarchy 도 base
  const horiz = copc.wkt ? extractHorizontalCrs(copc.wkt) : undefined;
  const toWgs = horiz ? (proj4(horiz.proj, proj4.WGS84) as unknown as Reproj) : undefined;
  const session: CopcSession = {
    copc,
    getter: base,
    nodes,
    pages,
    toWgs,
    zUnit: horiz ? horiz.linearUnit : 1,
    cube: copc.info.cube,
    spacing: copc.info.spacing,
  };
  // coalesce 켜면 point 읽기를 병합 getter 로(헤더/hierarchy 는 passthrough). 워커 세션만 사용.
  if (opts?.coalesce) {
    session.getter = createCoalescingGetter(
      base,
      () => Object.values(session.nodes).map((n) => ({ off: n.pointDataOffset, len: n.pointDataLength })),
      opts.coalesce,
    );
  }
  return session;
}
```

- [ ] **Step 2: 워커 open 에 coalesce 전달**

`src/decode.worker.ts` `open` API. `Entry` 타입과 `open` 의 `opts`에 `coalesce?: CoalesceOpts` 추가, `openCopc(url)` → `openCopc(url, { coalesce: opts?.coalesce })`. import 에 `type CoalesceOpts` 추가:
```ts
import { openCopc, decodeNode, loadSubPage, type CopcSession, type CoalesceOpts } from './copc-core';
```
`open` 본문:
```ts
  async open(
    sid: string,
    url: string,
    opts?: { colorBy?: ColorBy; hideClassifications?: number[]; attributes?: AttributeRequest; coalesce?: CoalesceOpts },
  ): Promise<void> {
    sessions.set(sid, {
      session: await openCopc(url, { coalesce: opts?.coalesce }),
      colorBy: opts?.colorBy ?? 'height',
      hideClass: new Set(opts?.hideClassifications ?? []),
      attrReq: opts?.attributes,
    });
  },
```

- [ ] **Step 3: tileset 노브 + fromUrl 전달**

`src/copc-tileset.ts` `CopcTilesetOptions`에 추가(`maxRequestsPerServer` 근처):
```ts
  /** range coalescing: 인접 노드 point-data 를 연속 range 로 병합(이슈 #02). gap 상한(바이트). 기본 256KB. `0` 이하면 off. */
  coalesceMaxGap?: number;
  /** coalescing run 당 최대 병합 크기(바이트). 기본 8MB. */
  coalesceMaxBytes?: number;
  /** coalescing region 캐시 총바이트 상한. 기본 64MB. */
  coalesceCacheBytes?: number;
```
`fromUrl` 의 `api.open(...)` 호출 직전에 coalesce 옵션 구성, `api.open`에 전달:
```ts
      const gap = options.coalesceMaxGap ?? 256 * 1024;
      const coalesce =
        gap > 0
          ? {
              maxGap: gap,
              maxBytes: options.coalesceMaxBytes ?? 8 * 1024 * 1024,
              cacheBytes: options.coalesceCacheBytes ?? 64 * 1024 * 1024,
            }
          : undefined;
      const [session] = await Promise.all([
        openCopc(url),
        api.open(sid, url, {
          colorBy: options.colorBy ?? 'rgb',
          hideClassifications: options.hideClassifications ?? [7, 18],
          attributes: options.attributes,
          coalesce,
        }),
      ]);
```
(페이지 `openCopc(url)`는 coalesce 안 줌 — geometry 만. 워커만 coalesce.)

- [ ] **Step 4: 데모 ?coalesce 배선**

`src/main.ts` `runDemo`(line ~863) `maxReq` 읽는 곳 근처에 추가하고 fromUrl 옵션에 병합:
```ts
  const coalesceParam = new URLSearchParams(location.search).get('coalesce');
  const coalesceMaxGap = coalesceParam === '0' ? 0 : undefined; // ?coalesce=0 → off (A/B)
```
그리고 fromUrl 호출(Task: 이전에 `?maxReq` 배선한 그 줄)을:
```ts
    const tileset = await CopcTileset.fromUrl(ds.url, {
      ...(maxReq > 0 ? { maxRequestsPerServer: maxReq } : {}),
      ...(coalesceMaxGap !== undefined ? { coalesceMaxGap } : {}),
    });
```

- [ ] **Step 5: 빌드 검증**

Run: `npm run build`
Expected: `✓ built` (tsc strict 통과 — 모든 시그니처 정합).

- [ ] **Step 6: Commit**

```bash
git add src/copc-core.ts src/decode.worker.ts src/copc-tileset.ts src/main.ts
git commit -m "feat(#02): coalescing 배선 — openCopc/worker/tileset 노브/데모 (5/N)"
```

---

### Task 6: 골든파일 동일성 + 프로파일 재측정 (실 S3)

**Files:**
- Modify: `scripts/check-coalesce.ts` (네트워크 골든파일 섹션 — 환경변수 가드)
- Test: `scripts/check-coalesce.ts` (network) + `scripts/bench/profile-io.ts` (재사용)

**Interfaces:**
- Consumes: `openCopc`, `decodeNode` (coalesce on/off), `?coalesce` 데모 노브.

- [ ] **Step 1: 골든파일 테스트 작성**

`scripts/check-coalesce.ts` 끝에 추가(네트워크라 `COALESCE_NET=1`일 때만):
```ts
// --- Task 6: 골든파일(실 S3, COALESCE_NET=1 일 때만) ---
// (상단 import 합치기: openCopc, decodeNode, loadSubPage. Node 라 lazPerf 생략 — copc 기본 node 빌드, verify.ts 패턴.)

if (process.env.COALESCE_NET === '1') {
  const NET_URL = 'https://s3.amazonaws.com/hobu-lidar/millsite.copc.laz';
  const plain = await openCopc(NET_URL); // coalesce off
  const coal = await openCopc(NET_URL, { coalesce: { maxGap: 256 * KB, maxBytes: 8 * MB, cacheBytes: 64 * MB } });
  // 루트+서브페이지 일부 로드해 깊은 노드 확보
  for (const k of Object.keys(plain.pages)) {
    if (Number(k.split('-')[0]) <= 2) {
      await loadSubPage(plain, k);
      await loadSubPage(coal, k);
    }
  }
  const keys = Object.keys(plain.nodes).filter((k) => Number(k.split('-')[0]) <= 3).slice(0, 5);
  for (const key of keys) {
    const a = await decodeNode(plain, key, undefined, 'rgb'); // Node: lazPerf 생략(copc node 빌드)
    const b = await decodeNode(coal, key, undefined, 'rgb');
    const same =
      !!a && !!b && a.count === b.count && a.lonLatH.length === b.lonLatH.length &&
      a.lonLatH.every((v, i) => v === b.lonLatH[i]);
    assert(same, `골든파일: 노드 ${key} per-node vs coalesced 동일(count=${a?.count})`);
  }
  console.log('Task 6 골든파일 passed');
} else {
  console.log('Task 6 골든파일 skip (COALESCE_NET=1 로 실행)');
}
console.log('check-coalesce 전체 passed');
```
(상단 import에 `loadSubPage` 추가.)

- [ ] **Step 2: 골든파일 실행 (red→green)**

Run: `COALESCE_NET=1 npx tsx scripts/check-coalesce.ts`
Expected: `골든파일: 노드 0-0-0-0 per-node vs coalesced 동일` … 5개 PASS, `Task 6 골든파일 passed`. (만약 FAIL이면 슬라이스/run 매핑 버그 — Task 3 회귀.)

- [ ] **Step 3: 프로파일 재측정 (검증기준 2·3)**

먼저 `profile-io.ts`에 coalesce A/B 인자 추가 — `maxReq`(argv[4]) 패턴 따라 argv[5]:
```ts
const coalesce = process.argv[5]; // '0' 이면 coalescing off (A/B)
// URL 구성부(maxReq append 다음)에:
const url = `http://localhost:5173/?ds=${ds}${maxReq > 0 ? `&maxReq=${maxReq}` : ''}${coalesce === '0' ? '&coalesce=0' : ''}`;
```
dev 서버 띄우고 A/B:
```bash
nohup npm run dev > /tmp/dev.log 2>&1 & sleep 4
npx tsx scripts/bench/profile-io.ts millsite 8         # coalesce on(기본)
npx tsx scripts/bench/profile-io.ts millsite 8 0 0     # argv[5]='0' → coalesce off
```
Expected: coalesce on → `S3 range 요청 ≤15` (기준 2), `settle < 8000ms` (기준 3). off → ~61/~16s(현행 = 폴백 검증, 기준 6).

측정값을 `docs/issues/02-deep-load-worker-pool.md` §8에 기록.

- [ ] **Step 4: Commit**

```bash
git add scripts/check-coalesce.ts scripts/bench/profile-io.ts docs/issues/02-deep-load-worker-pool.md
git commit -m "test(#02): 골든파일 동일성 + 프로파일 재측정(round-trip↓·settle↓) (6/N)"
```

---

### Task 7: ADR + 전체 회귀 + 문서

**Files:**
- Create: `docs/adr/006-range-coalescing.md`
- Modify: `docs/issues/02-deep-load-worker-pool.md` (Status), `docs/CHANGELOG.md`

**Interfaces:** 없음(문서·검증).

- [ ] **Step 1: 전체 회귀 스위트 (검증기준 4)**

Run 각각, 모두 PASS 확인:
```bash
npm run build                                   # tsc + vite
npm run verify                                  # C1 Oregon
COALESCE_NET=1 npx tsx scripts/check-coalesce.ts # 단위+골든파일
npx tsx scripts/bench/repro-03.ts millsite 8    # #03 회귀 → PASS ✓
npx tsx scripts/check-attributes.ts             # 속성 → PASS
npx tsx scripts/check-pnts-batch.ts             # 속성 → PASS
npx tsx scripts/check-attr-pipeline.ts          # 속성 → PASS
```
Expected: 전부 PASS. (#03 repro: tilesLoaded=true·processing=0. 속성: PASS decode-attributes 등.)

- [ ] **Step 2: 매칭 bench — 부드러움/메모리 불변 (검증기준 4)**

```bash
npm run bench:eptium -- --ds millsite --msse-ours 8 --msse-eptium 14 --settle 30000 --secs 12
```
Expected: ours frametime p95·peakHeap 가 매칭 베이스라인(±10%, ft95 ~9ms·heap ~74MB) 불변. TTD 는 단축됨(coalescing 효과).

- [ ] **Step 3: ADR 작성**

`docs/adr/006-range-coalescing.md` 생성: 상태 Accepted, 맥락(round-trip 격차 측정), 결정(캐싱 getter 데코레이터·two-cap·region-LRU·BP 근거 GDAL/fsspec/Zarr), 결과(round-trip·settle 측정값), ADR-004(throttle 6 유지)·#03 와의 관계.

- [ ] **Step 4: 이슈/CHANGELOG 갱신**

`docs/issues/02-...md` Status → `Resolved(후보)`. `docs/CHANGELOG.md` 2026-06-18 최상단에 `[perf] [issue #02] range coalescing — deep-load round-trip 61→N·settle 16s→Ns` 항목(측정값 채움).

- [ ] **Step 5: Commit**

```bash
git add docs/adr/006-range-coalescing.md docs/issues/02-deep-load-worker-pool.md docs/CHANGELOG.md
git commit -m "docs(#02): ADR-006 range coalescing + 회귀 PASS + 이슈/CHANGELOG (7/N)"
```

---

## 검증기준 점검 (구현 후)

- [ ] 골든파일 byte-identical (Task 6) — 기준 1
- [ ] round-trip 61 → ≤15 (Task 6) — 기준 2
- [ ] settle ~16s → <8s (Task 6) — 기준 3
- [ ] 회귀 0: build·verify·#03 repro·속성 3종·매칭 bench (Task 7) — 기준 4
- [ ] region 캐시 상한 준수(soak plateau) — 기준 5 (필요시 soak 측정)
- [ ] coalesce=0 폴백 동작 동일 (Task 6 off 측정) — 기준 6
