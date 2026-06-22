# 결정적 4축 병목 분해 하니스 (Node 3축) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** ours 내부 계산 파이프라인의 병목을 IO/decode/CPU(reproject+build) 축으로 결정적·반복가능하게 분해하는 Node 측정 하니스를 만든다.

**Architecture:** PDAL로 실데이터를 정규화한 COPC를 로컬 range 서버로 서빙 → Node 하니스가 copc.js로 열어 depth≤D 고정 노드집합을 디코드하며, 프로덕션 프리미티브(`Copc.loadPointDataView`/proj4/`heightColors`/`buildQuantizedPnts`)를 경계 타이머로 복제 호출해 축별 ms를 분리. K회 median, 점수 정규화(ms/1M점) 리포트.

**Tech Stack:** TypeScript + tsx(실행), copc.js(`copc`), proj4, Node `node:http`/`node:fs`(로컬 range 서버), PDAL(정규화 COPC 생성, 별도 바이너리). 테스트는 프로젝트 관례인 assert 기반 tsx 스크립트(`scripts/bench/check-*.ts` 스타일, jest 없음).

## Global Constraints

- **프로덕션 무수정**: `src/` diff 0. 하니스·테스트·PDAL 스크립트는 `scripts/bench/`·`docs/`·`data/`에만 추가.
- **TypeScript strict**, 기존 파일 스타일 따름. 주변 코드 "개선" 금지.
- **대용량 COPC 미커밋**: 정규화 산출물은 `data/`(gitignore). 생성 스크립트만 커밋.
- **결정성**: 동일 입력 K회 median의 축% 변동 < 5%p.
- **점수 정규화 병기**: 모든 축은 절대 ms와 함께 ms/1M점을 출력.
- 테스트 = `npx tsx scripts/bench/check-*.ts` (exit 0=PASS / 1=FAIL), 기존 `check-coalesce.ts` 관례.
- COPC range getter 계약: `(begin: number, end: number) => Promise<Uint8Array>` (copc.js `Getter`).

---

### Task 1: 로컬 range-capable 정적 서버

**Files:**
- Create: `scripts/bench/serve-copc.ts`
- Test: `scripts/bench/check-serve-copc.ts`

**Interfaces:**
- Produces: `startCopcServer(filePath: string, port?: number): Promise<{ url: string; close: () => Promise<void> }>` — 단일 파일을 `GET /file`로 HTTP Range 지원 서빙. `url`은 그 파일의 전체 URL.

- [ ] **Step 1: 실패 테스트 작성**

```ts
// scripts/bench/check-serve-copc.ts
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startCopcServer } from './serve-copc';

function assert(c: boolean, m: string) { if (!c) { console.log('FAIL ' + m); process.exit(1); } console.log('ok: ' + m); }

const dir = mkdtempSync(join(tmpdir(), 'copcsrv-'));
const f = join(dir, 'x.bin');
writeFileSync(f, Uint8Array.from([0,1,2,3,4,5,6,7,8,9]));

const srv = await startCopcServer(f);
const res = await fetch(srv.url, { headers: { Range: 'bytes=2-4' } });
assert(res.status === 206, 'range 요청은 206');
const buf = new Uint8Array(await res.arrayBuffer());
assert(JSON.stringify([...buf]) === JSON.stringify([2,3,4]), 'range 바이트 정확(2-4)');
assert(res.headers.get('content-range') === 'bytes 2-4/10', 'Content-Range 헤더 정확');
await srv.close();
console.log('SERVE PASS ✅');
```

- [ ] **Step 2: 실패 확인**

Run: `npx tsx scripts/bench/check-serve-copc.ts`
Expected: FAIL — `Cannot find module './serve-copc'` 또는 `startCopcServer is not a function`.

- [ ] **Step 3: 최소 구현**

```ts
// scripts/bench/serve-copc.ts — 단일 COPC 파일을 HTTP Range 로 서빙(로컬 IO 결정화용).
import { createServer } from 'node:http';
import { createReadStream, statSync } from 'node:fs';

export async function startCopcServer(
  filePath: string,
  port = 0, // 0 = OS 할당
): Promise<{ url: string; close: () => Promise<void> }> {
  const size = statSync(filePath).size;
  const server = createServer((req, res) => {
    const range = req.headers.range;
    if (range) {
      const m = /bytes=(\d+)-(\d+)?/.exec(range);
      const start = m ? Number(m[1]) : 0;
      const end = m && m[2] ? Number(m[2]) : size - 1;
      res.writeHead(206, {
        'Content-Range': `bytes ${start}-${end}/${size}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': end - start + 1,
        'Content-Type': 'application/octet-stream',
      });
      createReadStream(filePath, { start, end }).pipe(res);
    } else {
      res.writeHead(200, { 'Content-Length': size, 'Accept-Ranges': 'bytes' });
      createReadStream(filePath).pipe(res);
    }
  });
  await new Promise<void>((r) => server.listen(port, r));
  const addr = server.address();
  const p = typeof addr === 'object' && addr ? addr.port : port;
  return {
    url: `http://localhost:${p}/copc`,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}
```

- [ ] **Step 4: 통과 확인**

Run: `npx tsx scripts/bench/check-serve-copc.ts`
Expected: PASS — `SERVE PASS ✅`.

- [ ] **Step 5: 커밋**

```bash
git add scripts/bench/serve-copc.ts scripts/bench/check-serve-copc.ts
git commit -m "feat(bench): 로컬 range-capable COPC 정적 서버 (IO 결정화)"
```

---

### Task 2: 계측 getter (IO 축)

**Files:**
- Create: `scripts/bench/axis-getter.ts`
- Test: `scripts/bench/check-axis-getter.ts`

**Interfaces:**
- Produces:
  - `type IoRec = { ms: number; bytes: number }`
  - `makeTimedGetter(url: string, fetchImpl?: typeof fetch): { getter: (b: number, e: number) => Promise<Uint8Array>; io: IoRec[] }` — copc.js getter. 호출마다 fetch(Range) 총 ms와 바이트를 `io`에 push. `end<=begin`이면 빈 배열·기록 없음.

- [ ] **Step 1: 실패 테스트 작성**

```ts
// scripts/bench/check-axis-getter.ts
import { makeTimedGetter } from './axis-getter';

function assert(c: boolean, m: string) { if (!c) { console.log('FAIL ' + m); process.exit(1); } console.log('ok: ' + m); }

// 200ms 헤더 지연 mock fetch — IO ms 가 지연을 반영해야.
const slow = (async (_u: unknown, o: { signal?: AbortSignal }) => {
  await new Promise((r) => setTimeout(r, 200));
  return new Response(Uint8Array.from([9, 9, 9]), { status: 206 });
}) as unknown as typeof fetch;

const { getter, io } = makeTimedGetter('http://mock/copc', slow);
const bytes = await getter(0, 3);
assert(bytes.length === 3, 'getter 가 바이트 반환');
assert(io.length === 1, 'io 1건 기록');
assert(io[0].ms >= 190, `io ms 가 지연 반영(>=190, got ${io[0].ms.toFixed(0)})`);
assert(io[0].bytes === 3, 'io bytes=3');
const empty = await getter(5, 5);
assert(empty.length === 0 && io.length === 1, 'end<=begin 은 빈 배열·기록 없음');
console.log('GETTER PASS ✅');
```

- [ ] **Step 2: 실패 확인**

Run: `npx tsx scripts/bench/check-axis-getter.ts`
Expected: FAIL — 모듈/함수 없음.

- [ ] **Step 3: 최소 구현**

```ts
// scripts/bench/axis-getter.ts — copc.js getter 를 감싸 fetch(Range) 총 ms·바이트를 기록(IO 축).
export type IoRec = { ms: number; bytes: number };

export function makeTimedGetter(url: string, fetchImpl: typeof fetch = fetch) {
  const io: IoRec[] = [];
  const getter = async (begin: number, end: number): Promise<Uint8Array> => {
    if (end <= begin) return new Uint8Array(0);
    const t0 = performance.now();
    const res = await fetchImpl(url, { headers: { Range: `bytes=${begin}-${end - 1}` } });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${begin}-${end}`);
    const buf = new Uint8Array(await res.arrayBuffer());
    io.push({ ms: performance.now() - t0, bytes: buf.length });
    return buf;
  };
  return { getter, io };
}
```

- [ ] **Step 4: 통과 확인**

Run: `npx tsx scripts/bench/check-axis-getter.ts`
Expected: PASS — `GETTER PASS ✅`.

- [ ] **Step 5: 커밋**

```bash
git add scripts/bench/axis-getter.ts scripts/bench/check-axis-getter.ts
git commit -m "feat(bench): IO 축 계측 getter (fetch Range ms·bytes 기록)"
```

---

### Task 3: 단일 노드 4-측정 분해 (decode/reproject/build) + IO 분리 정확성

**Files:**
- Create: `scripts/bench/axis-measure.ts`
- Test: `scripts/bench/check-axis-measure.ts`

**Interfaces:**
- Consumes: `makeTimedGetter` (Task 2).
- Produces:
  - `type NodeAxes = { points: number; ioMs: number; decodeMs: number; reprojectMs: number; buildMs: number }`
  - `measureNode(getter, io, copc, node, toWgs, zUnit, zRange): Promise<NodeAxes | null>` — 한 노드를 디코드하며 축별 ms 측정. 0점 노드는 null.
    - `getter`/`io`: Task 2 산출. `copc`: `Copc.create` 결과. `node`: `Copc.loadHierarchyPage().nodes[key]`. `toWgs`/`zUnit`: `resolveCrs` 결과. `zRange: [number, number]`.
  - 축 경계 정의(eager/lazy-robust):
    - **IO** = 이 노드의 fetch 동안 `io`에 쌓인 ms 합.
    - **decode** = `loadPointDataView` + X/Y/Z 전체 materialize(디코드 강제) 시간 − 그 구간 IO.
    - **reproject** = 이미 materialize 된 X/Y 배열에 proj4.forward + zUnit 스케일.
    - **build** = `heightColors(zVals)` + `buildQuantizedPnts(lonLatH, colors)`.

- [ ] **Step 1: 실패 테스트 작성 (실 autzen, IO 분리 정확성 = 설계 AC#4)**

```ts
// scripts/bench/check-axis-measure.ts — autzen(실 S3)로 축 분리·IO 독립성 검증.
import { Copc } from 'copc';
import { resolveCrs } from '../../src/copc-core';
import { makeTimedGetter } from './axis-getter';
import { measureNode } from './axis-measure';

function assert(c: boolean, m: string) { if (!c) { console.log('FAIL ' + m); process.exit(1); } console.log('ok: ' + m); }
const URL = 'https://s3.amazonaws.com/hobu-lidar/autzen-classified.copc.laz';

async function firstNode(fetchImpl?: typeof fetch) {
  const { getter, io } = makeTimedGetter(URL, fetchImpl);
  const copc = await Copc.create(getter);
  const { nodes } = await Copc.loadHierarchyPage(getter, copc.info.rootHierarchyPage);
  const { toWgs, zUnit } = resolveCrs(copc.wkt);
  const zRange: [number, number] = [copc.header.min[2] * zUnit, copc.header.max[2] * zUnit];
  const key = Object.keys(nodes).filter((k) => nodes[k] && nodes[k]!.pointDataLength)[0];
  io.length = 0; // 노드 측정 직전 IO 버퍼 초기화
  const ax = await measureNode(getter, io, copc, nodes[key]!, toWgs, zUnit, zRange);
  return ax!;
}

// (a) 정상: 모든 축 > 0, points > 0
const base = await firstNode();
assert(base.points > 0, 'points > 0');
assert(base.decodeMs > 0 && base.reprojectMs > 0 && base.buildMs > 0, '세 내부축 모두 > 0');

// (b) IO 분리 정확성: 200ms 지연 getter → ioMs 만 +지연, decode/reproject/build 불변(±40%)
const delayed = await firstNode((async (u: string, o: { headers?: Record<string,string> }) => {
  await new Promise((r) => setTimeout(r, 200));
  return fetch(u, o as RequestInit);
}) as unknown as typeof fetch);
assert(delayed.ioMs >= base.ioMs + 150, `지연 getter 는 ioMs 증가(base ${base.ioMs.toFixed(0)} → ${delayed.ioMs.toFixed(0)})`);
const within = (a: number, b: number) => Math.abs(a - b) <= b * 0.4 + 2;
assert(within(delayed.decodeMs, base.decodeMs), `decode 는 IO 지연에 불변(${base.decodeMs.toFixed(1)} vs ${delayed.decodeMs.toFixed(1)})`);
console.log('MEASURE PASS ✅  축 분리·IO 독립 확인');
```

- [ ] **Step 2: 실패 확인**

Run: `npx tsx scripts/bench/check-axis-measure.ts`
Expected: FAIL — `Cannot find module './axis-measure'`.

- [ ] **Step 3: 최소 구현**

```ts
// scripts/bench/axis-measure.ts — 한 노드를 디코드하며 IO/decode/reproject/build 축을 분리 측정.
// 프로덕션 프리미티브를 경계 타이머로 복제(src 무수정). eager/lazy 무관하게 decode 구간서 X/Y/Z 강제 materialize.
import { Copc } from 'copc';
import { heightColors } from '../../src/colors';
import { buildQuantizedPnts } from '../../src/pnts-quantized';
import type { IoRec } from './axis-getter';

type Reproj = { forward: (xy: number[]) => number[] };
export type NodeAxes = { points: number; ioMs: number; decodeMs: number; reprojectMs: number; buildMs: number };

export async function measureNode(
  getter: (b: number, e: number) => Promise<Uint8Array>,
  io: IoRec[],
  copc: Awaited<ReturnType<typeof Copc.create>>,
  node: { pointDataOffset: number; pointDataLength: number },
  toWgs: Reproj,
  zUnit: number,
  zRange: [number, number],
): Promise<NodeAxes | null> {
  const ioStart = io.length;
  // --- decode: loadPointDataView + 전체 materialize (eager/lazy 무관 강제 디코드) ---
  const tDec = performance.now();
  const view = await Copc.loadPointDataView(getter, copc, node);
  const n = view.pointCount;
  if (n === 0) return null;
  const gx = view.getter('X'), gy = view.getter('Y'), gz = view.getter('Z');
  const xs = new Float64Array(n), ys = new Float64Array(n), zs = new Float64Array(n);
  for (let i = 0; i < n; i++) { xs[i] = gx(i); ys[i] = gy(i); zs[i] = gz(i); } // 강제 materialize
  const ioMs = io.slice(ioStart).reduce((a, r) => a + r.ms, 0);
  const decodeMs = performance.now() - tDec - ioMs;

  // --- reproject: proj4 forward + zUnit (이미 materialize 된 배열에만) ---
  const tRep = performance.now();
  const lonLatH: number[] = new Array(n * 3);
  const zVals: number[] = new Array(n);
  for (let i = 0; i < n; i++) {
    const z = zs[i] * zUnit;
    const out = toWgs.forward([xs[i], ys[i]]);
    lonLatH[i * 3] = out[0]; lonLatH[i * 3 + 1] = out[1]; lonLatH[i * 3 + 2] = z;
    zVals[i] = z;
  }
  const reprojectMs = performance.now() - tRep;

  // --- build: heightColors + buildQuantizedPnts ---
  const tBld = performance.now();
  const colors = heightColors(zVals, n, zRange);
  buildQuantizedPnts(lonLatH, colors);
  const buildMs = performance.now() - tBld;

  return { points: n, ioMs, decodeMs, reprojectMs, buildMs };
}
```

- [ ] **Step 4: 통과 확인**

Run: `npx tsx scripts/bench/check-axis-measure.ts`
Expected: PASS — `MEASURE PASS ✅`. (네트워크 필요. 실패 시 재시도; autzen 50k점 디코드는 verify.ts 에서 검증된 경로.)

- [ ] **Step 5: 커밋**

```bash
git add scripts/bench/axis-measure.ts scripts/bench/check-axis-measure.ts
git commit -m "feat(bench): 단일 노드 4-측정 축 분해 + IO 독립성 검증"
```

---

### Task 4: 노드집합 선택 + K회 median 집계 + 리포트

**Files:**
- Create: `scripts/bench/profile-axes.ts`
- Test: `scripts/bench/check-profile-axes.ts`

**Interfaces:**
- Consumes: `makeTimedGetter` (T2), `measureNode`/`NodeAxes` (T3).
- Produces:
  - `selectNodes(nodes, maxDepth: number): string[]` — depth ≤ maxDepth 이고 `pointDataLength>0` 인 키, depth 오름차순.
  - `aggregate(runs: NodeAxes[][]): AxisReport` — K회 run(각 run = 노드별 NodeAxes 배열)에서 run별 축 합 → median. `type AxisReport = { points: number; io: AxisStat; decode: AxisStat; reproject: AxisStat; build: AxisStat; totalMs: number }`, `type AxisStat = { ms: number; pct: number; msPerM: number }`.
  - `formatReport(label: string, r: AxisReport): string` — md 표 + BOTTLENECK 한 줄.

- [ ] **Step 1: 실패 테스트 작성 (집계·결정성 = 설계 AC#3, 순수 함수)**

```ts
// scripts/bench/check-profile-axes.ts — 집계·median·정규화 순수 로직 검증(네트워크 무관).
import { aggregate, selectNodes } from './profile-axes';
import type { NodeAxes } from './axis-measure';

function assert(c: boolean, m: string) { if (!c) { console.log('FAIL ' + m); process.exit(1); } console.log('ok: ' + m); }

// selectNodes: depth = key 의 첫 토큰
const nodes: any = { '0-0-0-0': { pointDataLength: 10 }, '1-0-0-0': { pointDataLength: 5 }, '2-0-0-0': { pointDataLength: 0 }, '1-1-0-0': { pointDataLength: 7 } };
const sel = selectNodes(nodes, 1);
assert(JSON.stringify(sel) === JSON.stringify(['0-0-0-0', '1-0-0-0', '1-1-0-0']), 'depth≤1·점>0 만, depth 오름차순');

// aggregate: 2 run × 2 노드. run 합 = 노드 합. median(2개)=상위값(Math.floor(0.5*2)=1 → 정렬 2번째)
const r1: NodeAxes[] = [
  { points: 1_000_000, ioMs: 1, decodeMs: 10, reprojectMs: 2, buildMs: 1 },
  { points: 1_000_000, ioMs: 1, decodeMs: 10, reprojectMs: 2, buildMs: 1 },
];
const r2: NodeAxes[] = [
  { points: 1_000_000, ioMs: 1, decodeMs: 20, reprojectMs: 4, buildMs: 2 },
  { points: 1_000_000, ioMs: 1, decodeMs: 20, reprojectMs: 4, buildMs: 2 },
];
const agg = aggregate([r1, r2]);
assert(agg.points === 2_000_000, 'points 합 = 2M (run 무관 동일)');
// run 합: run1 decode=20, run2 decode=40 → median(2개)=40
assert(agg.decode.ms === 40, `decode median run-sum = 40 (got ${agg.decode.ms})`);
assert(Math.abs(agg.decode.msPerM - 40 / 2) < 1e-6, 'decode ms/1M점 = 20');
const pctSum = agg.io.pct + agg.decode.pct + agg.reproject.pct + agg.build.pct;
assert(Math.abs(pctSum - 100) < 0.5, '축 % 합 ≈ 100');
console.log('AGG PASS ✅');
```

- [ ] **Step 2: 실패 확인**

Run: `npx tsx scripts/bench/check-profile-axes.ts`
Expected: FAIL — 모듈/함수 없음.

- [ ] **Step 3: 최소 구현 (집계·선택·포맷 + main 러너)**

```ts
// scripts/bench/profile-axes.ts — 정규화 COPC 의 내부 계산 4축(IO/decode/reproject/build) 분해.
// 사용: npx tsx scripts/bench/profile-axes.ts <copcUrl> [maxDepth=3] [runs=5]
//   copcUrl 은 로컬 서버(serve-copc) URL 권장(IO 결정화). S3 URL 도 가능.
import { Copc } from 'copc';
import { resolveCrs } from '../../src/copc-core';
import { makeTimedGetter } from './axis-getter';
import { measureNode, type NodeAxes } from './axis-measure';

export function selectNodes(nodes: Record<string, { pointDataLength: number } | undefined>, maxDepth: number): string[] {
  return Object.keys(nodes)
    .filter((k) => nodes[k] && nodes[k]!.pointDataLength > 0 && Number(k.split('-')[0]) <= maxDepth)
    .sort((a, b) => Number(a.split('-')[0]) - Number(b.split('-')[0]));
}

export type AxisStat = { ms: number; pct: number; msPerM: number };
export type AxisReport = { points: number; io: AxisStat; decode: AxisStat; reproject: AxisStat; build: AxisStat; totalMs: number };

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(0.5 * s.length))];
}

export function aggregate(runs: NodeAxes[][]): AxisReport {
  const sum = (run: NodeAxes[], k: keyof NodeAxes) => run.reduce((a, x) => a + x[k], 0);
  const io = median(runs.map((r) => sum(r, 'ioMs')));
  const decode = median(runs.map((r) => sum(r, 'decodeMs')));
  const reproject = median(runs.map((r) => sum(r, 'reprojectMs')));
  const build = median(runs.map((r) => sum(r, 'buildMs')));
  const points = median(runs.map((r) => sum(r, 'points')));
  const totalMs = io + decode + reproject + build;
  const stat = (ms: number): AxisStat => ({ ms, pct: totalMs ? (ms / totalMs) * 100 : 0, msPerM: points ? ms / (points / 1e6) : 0 });
  return { points, io: stat(io), decode: stat(decode), reproject: stat(reproject), build: stat(build), totalMs };
}

export function formatReport(label: string, r: AxisReport): string {
  const rows: Array<[string, AxisStat]> = [['IO(local)', r.io], ['decode(laz)', r.decode], ['reproject(proj4)', r.reproject], ['build(pnts)', r.build]];
  const top = rows.reduce((m, x) => (x[1].ms > m[1].ms ? x : m));
  const line = (name: string, s: AxisStat) =>
    `| ${name.padEnd(16)} | ${s.ms.toFixed(1).padStart(8)} | ${s.pct.toFixed(0).padStart(3)}% | ${s.msPerM.toFixed(1).padStart(8)} |${name === top[0] ? ' ◄ BOTTLENECK' : ''}`;
  return [
    `### 4축 분해 — ${label} (${(r.points / 1e6).toFixed(2)}M점)`,
    '',
    '| 축 | ms | % | ms/1M점 |',
    '|----|----|---|---------|',
    ...rows.map(([n, s]) => line(n, s)),
    `| **internal** | **${r.totalMs.toFixed(1)}** | 100% | | |`,
    '',
    `**BOTTLENECK: ${top[0]}** (${top[1].pct.toFixed(0)}%, ${top[1].msPerM.toFixed(1)} ms/1M점)`,
  ].join('\n');
}

async function main() {
  const url = process.argv[2];
  if (!url) { console.error('usage: profile-axes.ts <copcUrl> [maxDepth=3] [runs=5]'); process.exit(1); }
  const maxDepth = Number(process.argv[3] || '3');
  const runs = Number(process.argv[4] || '5');

  const { getter, io } = makeTimedGetter(url);
  const copc = await Copc.create(getter);
  const { nodes } = await Copc.loadHierarchyPage(getter, copc.info.rootHierarchyPage);
  const { toWgs, zUnit } = resolveCrs(copc.wkt);
  const zRange: [number, number] = [copc.header.min[2] * zUnit, copc.header.max[2] * zUnit];
  const keys = selectNodes(nodes as any, maxDepth);
  if (!keys.length) { console.error('선택된 노드 0개'); process.exit(1); }

  const allRuns: NodeAxes[][] = [];
  for (let run = 0; run < runs + 1; run++) {
    const out: NodeAxes[] = [];
    for (const k of keys) {
      io.length = 0;
      const ax = await measureNode(getter, io, copc, nodes[k]!, toWgs, zUnit, zRange);
      if (ax) out.push(ax);
    }
    if (run > 0) allRuns.push(out); // run 0 = 워밍업 제외
  }
  const report = aggregate(allRuns);
  console.log(formatReport(`${url} · depth≤${maxDepth} · ${keys.length}노드 · ${runs}회median`, report));
}
// 직접 실행 시에만 main (테스트 import 시 미실행)
if (process.argv[1] && process.argv[1].endsWith('profile-axes.ts')) main();
```

- [ ] **Step 4: 통과 확인**

Run: `npx tsx scripts/bench/check-profile-axes.ts`
Expected: PASS — `AGG PASS ✅`.

- [ ] **Step 5: 커밋**

```bash
git add scripts/bench/profile-axes.ts scripts/bench/check-profile-axes.ts
git commit -m "feat(bench): 노드집합 선택 + K회 median 집계 + 4축 리포트"
```

---

### Task 5: PDAL 정규화 COPC 생성 스크립트 + 데이터 캐시 규칙

**Files:**
- Create: `scripts/bench/gen-norm-copc.json` (PDAL 파이프라인), `scripts/bench/gen-norm-copc.sh` (래퍼)
- Modify: `.gitignore` (이미 `data/` 무시면 확인만), `README.md` 또는 `docs/PROFILING.md` (재생성 1줄)

**Interfaces:**
- Produces: `data/norm-autzen-2M.copc.laz` — autzen 을 ~2M점으로 decimation, 고정 출력.

- [ ] **Step 1: PDAL 파이프라인 작성**

```json
// scripts/bench/gen-norm-copc.json — 실 autzen 을 고정 점수로 정규화(공간 일관성 보존).
[
  { "type": "readers.copc", "filename": "https://s3.amazonaws.com/hobu-lidar/autzen-classified.copc.laz" },
  { "type": "filters.decimation", "step": 5 },
  { "type": "writers.copc", "filename": "data/norm-autzen-2M.copc.laz" }
]
```

- [ ] **Step 2: 래퍼 + 검증 스크립트 작성**

```bash
# scripts/bench/gen-norm-copc.sh — PDAL 로 정규화 COPC 생성 + 점수/bounds 출력.
#!/usr/bin/env bash
set -euo pipefail
command -v pdal >/dev/null || { echo "PDAL 필요: brew install pdal (또는 conda install -c conda-forge pdal)"; exit 1; }
mkdir -p data
pdal pipeline scripts/bench/gen-norm-copc.json
echo "=== 생성 결과 ==="
pdal info data/norm-autzen-2M.copc.laz --summary | grep -E '"count"|"bounds"' || true
```

- [ ] **Step 3: 실행 + 결정성 확인 (PDAL 설치 환경)**

Run: `bash scripts/bench/gen-norm-copc.sh && bash scripts/bench/gen-norm-copc.sh`
Expected: 두 번 모두 동일 `count`(≈2M, decimation step 5 결정적). `data/norm-autzen-2M.copc.laz` 생성.
(PDAL 미설치면 Step 2 가드가 설치 안내 출력 — 그 경우 S3 autzen URL 로 하니스 검증하고 정규화는 설치 후.)

- [ ] **Step 4: gitignore 확인 + README 한 줄**

Run: `grep -q '^data/' .gitignore && echo "data/ ignored OK" || echo 'data/' >> .gitignore`
`docs/PROFILING.md` 끝에 추가:

```markdown
## 4축 병목 하니스 (결정적, Node)
- 정규화 COPC 생성(PDAL 필요): `bash scripts/bench/gen-norm-copc.sh`
- 로컬 서버+측정: Task 6 의 `npm run profile:axes` 참조.
```

- [ ] **Step 5: 커밋**

```bash
git add scripts/bench/gen-norm-copc.json scripts/bench/gen-norm-copc.sh .gitignore docs/PROFILING.md
git commit -m "feat(bench): PDAL 정규화 COPC 생성 스크립트 (실데이터 decimation)"
```

---

### Task 6: end-to-end 배선 (로컬 서버 + 하니스) + 리포트 산출 + npm 스크립트

**Files:**
- Create: `scripts/bench/run-axis-profile.ts` (서버 기동 → 하니스 → 리포트 파일)
- Modify: `package.json` (scripts 추가)
- Create: `docs/bench/axis-autzen-2M.md` (산출 예시, 커밋)

**Interfaces:**
- Consumes: `startCopcServer` (T1), `profile-axes` 내부 함수(T4). 본 태스크는 `profile-axes.ts` 의 export 를 재사용해 서버+측정+파일출력을 묶는다.

- [ ] **Step 1: e2e 러너 작성**

```ts
// scripts/bench/run-axis-profile.ts — 로컬 서버 기동 → 4축 측정 → md/json 산출.
// 사용: npx tsx scripts/bench/run-axis-profile.ts [data/norm-autzen-2M.copc.laz] [maxDepth=3] [runs=5]
import { writeFileSync, existsSync } from 'node:fs';
import { Copc } from 'copc';
import { resolveCrs } from '../../src/copc-core';
import { startCopcServer } from './serve-copc';
import { makeTimedGetter } from './axis-getter';
import { measureNode, type NodeAxes } from './axis-measure';
import { selectNodes, aggregate, formatReport } from './profile-axes';

async function main() {
  const file = process.argv[2] || 'data/norm-autzen-2M.copc.laz';
  const maxDepth = Number(process.argv[3] || '3');
  const runs = Number(process.argv[4] || '5');
  if (!existsSync(file)) { console.error(`없음: ${file} — 먼저 bash scripts/bench/gen-norm-copc.sh`); process.exit(1); }

  const srv = await startCopcServer(file);
  try {
    const { getter, io } = makeTimedGetter(srv.url);
    const copc = await Copc.create(getter);
    const { nodes } = await Copc.loadHierarchyPage(getter, copc.info.rootHierarchyPage);
    const { toWgs, zUnit } = resolveCrs(copc.wkt);
    const zRange: [number, number] = [copc.header.min[2] * zUnit, copc.header.max[2] * zUnit];
    const keys = selectNodes(nodes as any, maxDepth);

    const allRuns: NodeAxes[][] = [];
    for (let r = 0; r < runs + 1; r++) {
      const out: NodeAxes[] = [];
      for (const k of keys) { io.length = 0; const ax = await measureNode(getter, io, copc, nodes[k]!, toWgs, zUnit, zRange); if (ax) out.push(ax); }
      if (r > 0) allRuns.push(out);
    }
    const rep = aggregate(allRuns);
    const label = `${file} · depth≤${maxDepth} · ${keys.length}노드 · ${runs}회median`;
    const md = formatReport(label, rep);
    console.log(md);
    writeFileSync('docs/bench/axis-autzen-2M.md', md + '\n');
    writeFileSync('docs/bench/axis-autzen-2M.json', JSON.stringify(rep, null, 2) + '\n');
  } finally {
    await srv.close();
  }
}
main();
```

- [ ] **Step 2: package.json 스크립트 추가**

`package.json` 의 `scripts` 에 추가:

```json
"profile:axes": "tsx scripts/bench/run-axis-profile.ts"
```

- [ ] **Step 3: 전체 검증 (PDAL 설치 시) 또는 S3 폴백**

Run (PDAL 있음): `bash scripts/bench/gen-norm-copc.sh && npm run profile:axes`
Run (PDAL 없음, S3 폴백으로 하니스만): `npx tsx scripts/bench/profile-axes.ts https://s3.amazonaws.com/hobu-lidar/autzen-classified.copc.laz 3 5`
Expected: 4축 표 출력 + `BOTTLENECK: ...` 한 줄. `docs/bench/axis-autzen-2M.{md,json}` 생성(e2e 경로).

- [ ] **Step 4: 회귀 가드 — 프로덕션 무수정 확인**

Run: `git diff --name-only main...HEAD -- src/`
Expected: 빈 출력(= `src/` 무수정, Global Constraint).
Run: `npx tsc --noEmit`
Expected: 통과.

- [ ] **Step 5: 커밋**

```bash
git add scripts/bench/run-axis-profile.ts package.json docs/bench/axis-autzen-2M.md docs/bench/axis-autzen-2M.json
git commit -m "feat(bench): e2e 4축 프로파일러 배선 + npm run profile:axes + 산출"
```

---

## Self-Review

**1. Spec coverage:**
- §2 IN(IO/decode/CPU=reproject+build) → Task 3(measureNode 4측정). ✅
- §2 PDAL 정규화 COPC → Task 5. ✅
- §2 로컬 정적 서버 → Task 1. ✅
- §2 점수 정규화 ms/1M점 → Task 4(aggregate.msPerM). ✅
- §4 PDAL 파이프라인(readers.copc→decimation→writers.copc) → Task 5 Step 1. ✅
- §5 축 경계(decode=loadPointDataView+materialize−IO) → Task 3 구현. ✅ (spec 의 "total−IO"를 eager/lazy-robust 한 "materialize−IO"로 정련 — §5 위험 항목 해소.)
- §5 고정 노드집합 depth≤D → Task 4 selectNodes. ✅
- §6 출력(표+ms/1M점+BOTTLENECK) → Task 4 formatReport, Task 6 파일산출. ✅
- §7 K회 median+워밍업 제외 → Task 4/6 (`run 0` 제외). ✅
- AC#1 COPC 결정성 → Task 5 Step 3. ✅
- AC#2 4축 분리(합≈총) → Task 4 aggregate.totalMs = 축합(정의상 성립). ✅
- AC#3 결정성<5%p → Task 4 median 구조 + 검증은 e2e 반복 관측(Task 6 출력으로 확인). ⚠️ 자동 단언 아님 — Task 4 테스트는 median 로직만. 결정성 수치 게이트는 e2e 관측. (허용: 머신 의존이라 단위테스트 부적합.)
- AC#4 decode↔IO 분리 → Task 3 Step 1 (b) 지연 getter 단언. ✅
- AC#5 ms/1M점 안정 → Task 4 msPerM. ✅
- AC#6 src 무수정 → Task 6 Step 4 가드. ✅

**2. Placeholder scan:** 모든 step 에 실제 코드/명령/기대출력 있음. "적절한 에러처리" 류 없음. ✅

**3. Type consistency:**
- `makeTimedGetter → { getter, io }`, `io: IoRec[]` — T2 정의, T3·T4·T6 소비 일치. ✅
- `measureNode(getter, io, copc, node, toWgs, zUnit, zRange) → NodeAxes|null` — T3 정의, T4·T6 호출 시그니처 일치. ✅
- `NodeAxes` 필드(points/ioMs/decodeMs/reprojectMs/buildMs) — T3 정의, T4 aggregate `keyof NodeAxes` 합산·테스트 일치. ✅
- `AxisReport`/`AxisStat`/`selectNodes`/`aggregate`/`formatReport` — T4 정의, T6 소비 일치. ✅
- `resolveCrs`(copc-core), `heightColors`(colors), `buildQuantizedPnts`(pnts-quantized) — 실 export 확인됨. ✅

**보완**: AC#3 결정성은 자동 게이트가 아니라 e2e 반복 관측으로 남김(머신 노이즈 의존이라 단위 단언 부적합) — 실행자는 Task 6 출력을 2회 비교해 축% 변동 <5%p 확인.
