import { Copc, Getter, Hierarchy } from 'copc';
import proj4 from 'proj4';
import pRetry, { AbortError } from 'p-retry';
import type { LazPerf } from 'laz-perf/lib/web';
import {
  type ColorBy,
  heightColors,
  intensityColors,
  classificationColors,
  returnColors,
  rgbColors,
} from './colors';
import type { AttributeSpec } from './attributes';

// 순수 데이터 파이프라인 — Cesium/브라우저 무관. Node 에서도 그대로 돈다.
// (Giro3D 의 source/entity 분리와 동일: 여기는 source = fetch + decode + reproject)

// ── 네트워크 복원력: COPC range 읽기 재시도 + 타임아웃 ──
// copc 기본 Getter.http 는 response.ok 검사도 retry 도 없어 5xx/416 에러 바디를 점 데이터로
// 둔갑시키는 조용한 실패가 있다. 이 getter 는 status 를 검사해 명확히 실패시키고, 일시적 실패는
// 지수백오프+지터로 재시도하며 시도마다 타임아웃을 건다. copc.js 의 3경로(header/hierarchy/point)가
// 모두 이 함수를 사용하므로 한 곳에서 전부 커버된다. (Node·브라우저·워커 공통 — fetch/AbortSignal.timeout)
export type RangeGetter = (begin: number, end: number) => Promise<Uint8Array>;
const RETRYABLE_HTTP = new Set([429, 500, 502, 503, 504]); // 그 외 4xx·416 은 결정적 → 재시도 X
const FETCH_TIMEOUT_MS = 8000;

/** range 크기 비례 타임아웃 — 큰 coalesced run 이 작은-청크 타임아웃에 걸리지 않게. */
export function rangeTimeoutMs(begin: number, end: number, baseMs: number): number {
  return Math.max(baseMs, Math.ceil((end - begin) / (1024 * 1024)) * 2000);
}

export function httpGetterWithRetry(
  url: string,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = FETCH_TIMEOUT_MS,
): RangeGetter {
  return (begin, end) =>
    pRetry(
      async () => {
        const res = await fetchImpl(url, {
          headers: { Range: `bytes=${begin}-${end - 1}` },
          signal: AbortSignal.timeout(rangeTimeoutMs(begin, end, timeoutMs)), // 시도마다 새 one-shot signal
        });
        if (!res.ok) {
          const msg = `COPC range ${begin}-${end}: HTTP ${res.status} (${url})`;
          if (!RETRYABLE_HTTP.has(res.status)) throw new AbortError(msg); // 결정적 → 즉시 중단
          throw new Error(msg); // 429/5xx → 재시도
        }
        return new Uint8Array(await res.arrayBuffer());
      },
      {
        retries: 3,
        factor: 2,
        minTimeout: 300,
        maxTimeout: 3000,
        randomize: true, // 풀 지터 — 동시 타일 다수의 thundering-herd 완화
        onFailedAttempt: ({ error, attemptNumber, retriesLeft }) =>
          console.warn(`[copc] range 재시도 (시도 ${attemptNumber}, 남은 ${retriesLeft}): ${error.message}`),
      },
    );
}

export interface CorePoints {
  /** [lon, lat, height(m), ...] 평탄 배열 */
  lonLatH: number[];
  /** 높이값(m) 배열 — 색칠/통계용 */
  zVals: number[];
  pointCount: number;
  crsWkt: string | undefined;
  /** 4축 진단용 (docs/PROFILING.md). fetchDecodeMs 는 ①fetch+②decode+proj4 reproject 포함 */
  timings: { createMs: number; hierarchyMs: number; fetchDecodeMs: number };
}

/**
 * naive 로드: 루트부터 깊이 오름차순으로 노드를 모아 pointBudget 까지 점을 수집한다.
 * LOD/스트리밍/컬링 없음 — 의도적으로 단순. 성능 벽 측정용 baseline.
 *
 * @param lazPerf 브라우저에선 web 빌드 인스턴스를 주입. Node 에선 생략(copc 기본 node 빌드 사용).
 */
export async function loadCopcPoints(
  url: string,
  pointBudget: number,
  lazPerf?: LazPerf,
): Promise<CorePoints> {
  const getter = httpGetterWithRetry(url);

  let t = performance.now();
  const copc = await Copc.create(getter);
  const createMs = performance.now() - t;

  t = performance.now();
  const { nodes } = await Copc.loadHierarchyPage(getter, copc.info.rootHierarchyPage);
  const hierarchyMs = performance.now() - t;

  // 얕은 노드부터 (키 'd-x-y-z' 의 d 오름차순)
  const keys = Object.keys(nodes)
    .filter((k) => nodes[k])
    .sort((a, b) => Number(a.split('-')[0]) - Number(b.split('-')[0]));

  // 좌표계: 투영 CRS(wkt) → 경위도. COMPD_CS면 내부 PROJCS만 추출, 선형단위로 Z 보정.
  const wkt = copc.wkt;
  const horiz = wkt ? extractHorizontalCrs(wkt) : undefined;
  const toWgs = horiz ? proj4(horiz.proj, proj4.WGS84) : undefined;
  const zUnit = horiz ? horiz.linearUnit : 1;

  const lonLatH: number[] = [];
  const zVals: number[] = [];

  t = performance.now();
  let collected = 0;
  for (const key of keys) {
    if (collected >= pointBudget) break;
    const node = nodes[key]!;
    const view = await Copc.loadPointDataView(getter, copc, node, lazPerf ? { lazPerf } : undefined);
    const gx = view.getter('X');
    const gy = view.getter('Y');
    const gz = view.getter('Z');
    const n = Math.min(view.pointCount, pointBudget - collected);
    for (let i = 0; i < n; i++) {
      const x = gx(i);
      const y = gy(i);
      const z = gz(i) * zUnit;
      let lon = x;
      let lat = y;
      if (toWgs) {
        const out = toWgs.forward([x, y]) as number[];
        lon = out[0];
        lat = out[1];
      }
      lonLatH.push(lon, lat, z);
      zVals.push(z);
    }
    collected += n;
  }
  const fetchDecodeMs = performance.now() - t;

  return { lonLatH, zVals, pointCount: collected, crsWkt: wkt, timings: { createMs, hierarchyMs, fetchDecodeMs } };
}

/**
 * WKT에서 proj4가 읽을 수 있는 수평 CRS를 추출한다.
 * COMPD_CS(복합좌표계)면 내부 PROJCS만 균형 괄호로 잘라낸다 (proj4는 COMPD_CS 미지원).
 * 선형 단위 factor(예: 피트 0.3048)도 함께 반환해 Z 높이 보정에 쓴다.
 */
export function extractHorizontalCrs(wkt: string): { proj: string; linearUnit: number } {
  let proj = wkt;
  const i = wkt.indexOf('PROJCS[');
  if (wkt.startsWith('COMPD_CS') && i >= 0) {
    let depth = 0;
    let end = -1;
    for (let j = i + 'PROJCS'.length; j < wkt.length; j++) {
      const c = wkt[j];
      if (c === '[') depth++;
      else if (c === ']') {
        depth--;
        if (depth === 0) {
          end = j + 1;
          break;
        }
      }
    }
    if (end > 0) proj = wkt.slice(i, end);
  }
  let linearUnit = 1;
  if (proj.includes('PROJCS[')) {
    const units = [...proj.matchAll(/UNIT\["[^"]*",\s*([0-9.]+)/g)];
    if (units.length) linearUnit = Number(units[units.length - 1][1]);
  }
  return { proj, linearUnit };
}

// ── 스트리밍 세션 (Phase 2 본편) ───────────────────────────────────────
type Reproj = { forward: (coord: number[]) => number[] };

export interface CopcSession {
  copc: Copc;
  getter: Getter;
  nodes: Hierarchy.Node.Map;
  /** 미로드 자식 하이어라키 페이지 포인터(key→{pageOffset,pageLength}). lazy 페이징용. */
  pages: Hierarchy.Page.Map;
  toWgs?: Reproj;
  zUnit: number;
  cube: number[]; // [minx,miny,minz,maxx,maxy,maxz] (root, 큐브)
  spacing: number;
}

/** COPC 를 열어 헤더 + 옥트리(루트 페이지) + 좌표변환을 준비 (스트리밍 세션). */
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
      () => (Object.values(session.nodes).filter((n): n is NonNullable<typeof n> => n != null).map((n) => ({ off: n.pointDataOffset, len: n.pointDataLength }))),
      opts.coalesce,
    );
  }
  return session;
}

/**
 * 미로드 서브페이지(pages[key])를 로드해 세션 nodes/pages 에 병합 (lazy 하이어라키 페이징).
 * 동일 시그니처(루트 페이지와 같은 호출)로 자식 페이지를 가져온다. 이미 로드/페이지 아님이면 no-op false.
 *
 * ⚠️ 알려진 한계: 방문한 노드는 세션 destroy 까지 누적되며 축출되지 않는다(페이지+워커 양쪽).
 * 깊은/장시간 항해 시 nodes 단조 증가 → 메모리 상한(LRU)은 측정 후 도입 예정(handoff Step1+ ③).
 */
export async function loadSubPage(s: CopcSession, key: string): Promise<boolean> {
  const ptr = s.pages[key];
  if (!ptr) return false;
  // --8<-- [start:loadSubPage]
  const sub = await Copc.loadHierarchyPage(s.getter, ptr);
  Object.assign(s.nodes, sub.nodes); // K 와 그 하위 실노드
  Object.assign(s.pages, sub.pages); // 더 깊은 미로드 페이지 포인터
  delete s.pages[key]; // 로드 완료 → 더는 미로드 포인터 아님
  // --8<-- [end:loadSubPage]
  return true;
}

/**
 * 한 노드(key='D-X-Y-Z')의 모든 점을 디코드해 경위도+높이로 반환. 없으면 null.
 * colorBy 를 주면 그 모드의 점당 RGB(colors)도 만든다. 해당 차원이 없으면 height 로 폴백(console.warn).
 * hideClass 의 classification(예: ASPRS 노이즈 7·18)은 디코드 시 제외 → 렌더·메모리·카운트에서 빠진다.
 */
export async function decodeNode(
  s: CopcSession,
  key: string,
  lazPerf?: LazPerf,
  colorBy?: ColorBy,
  hideClass?: ReadonlySet<number>,
  attrs?: AttributeSpec[],
): Promise<{ lonLatH: number[]; zVals: number[]; count: number; colors?: Uint8Array; attrValues?: number[][] } | null> {
  const node = s.nodes[key];
  if (!node) return null;
  const view = await Copc.loadPointDataView(s.getter, s.copc, node, lazPerf ? { lazPerf } : undefined);
  const n = view.pointCount;
  const gx = view.getter('X');
  const gy = view.getter('Y');
  const gz = view.getter('Z');
  const gc = hideClass?.size && 'Classification' in view.dimensions ? view.getter('Classification') : null;

  const lonLatH: number[] = [];
  const zVals: number[] = [];
  const keep: number[] = []; // 제외 안 된 원본 인덱스 — colorize 가 다른 차원을 같은 점에서 읽도록
  for (let i = 0; i < n; i++) {
    if (gc && hideClass!.has(gc(i) | 0)) continue;
    const x = gx(i);
    const y = gy(i);
    const z = gz(i) * s.zUnit;
    let lon = x;
    let lat = y;
    if (s.toWgs) {
      const o = s.toWgs.forward([x, y]);
      lon = o[0];
      lat = o[1];
    }
    lonLatH.push(lon, lat, z);
    zVals.push(z);
    keep.push(i);
  }
  const colors = colorBy ? colorize(s, view, keep, colorBy, zVals) : undefined;
  const attrValues = attrs?.length
    ? attrs.map((spec) => readArr(view.getter(spec.lasName), keep))
    : undefined;
  return { lonLatH, zVals, count: keep.length, colors, attrValues };
}

// colorBy 차원이 없어 height 로 폴백할 때, 세션당 한 번만 경고(타일마다 스팸 방지·표면화는 유지).
const warnedFallback = new WeakSet<CopcSession>();

type PointView = Awaited<ReturnType<typeof Copc.loadPointDataView>>;

/** getter 로 한 차원을 keep 인덱스에서만 number[] 로 읽는다(제외된 점은 건너뜀). */
function readArr(g: (i: number) => number, keep: number[]): number[] {
  const a = new Array<number>(keep.length);
  for (let j = 0; j < keep.length; j++) a[j] = g(keep[j]);
  return a;
}

/** colorBy 모드 → 점당 RGB. 차원이 없으면 height 폴백(조용한 실패 없이 세션당 1회 warn). 색 매핑은 colors.ts. */
function colorize(s: CopcSession, view: PointView, keep: number[], colorBy: ColorBy, zVals: number[]): Uint8Array {
  const n = keep.length;
  const has = (d: string) => d in view.dimensions;
  // 고도 색은 노드별이 아니라 데이터셋 전역 Z 범위(COPC 헤더)로 정규화 → 노드 간 색 일관(Potree elevationRange).
  const zRange: [number, number] = [s.copc.header.min[2] * s.zUnit, s.copc.header.max[2] * s.zUnit];
  switch (colorBy) {
    case 'height':
      return heightColors(zVals, n, zRange);
    case 'rgb':
      if (has('Red') && has('Green') && has('Blue'))
        return rgbColors(readArr(view.getter('Red'), keep), readArr(view.getter('Green'), keep), readArr(view.getter('Blue'), keep), n);
      break;
    case 'classification':
      if (has('Classification')) return classificationColors(readArr(view.getter('Classification'), keep), n);
      break;
    case 'intensity':
      if (has('Intensity')) return intensityColors(readArr(view.getter('Intensity'), keep), n);
      break;
    case 'returns':
      if (has('ReturnNumber')) return returnColors(readArr(view.getter('ReturnNumber'), keep), n);
      break;
  }
  if (!warnedFallback.has(s)) {
    console.warn(`[copc] colorBy '${colorBy}' 차원 없음 → height 폴백 (이후 동일 경고 생략)`);
    warnedFallback.add(s);
  }
  return heightColors(zVals, n, zRange);
}

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

export interface RegionCache {
  lookup(begin: number, end: number): Uint8Array | undefined;
  insert(start: number, end: number, bytes: Uint8Array): void;
}

interface CachedRegion {
  start: number;
  end: number;
  bytes: Uint8Array;
}

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
      p.then(
        (b) => {
          try {
            cache.insert(run.start, run.end, b);
          } catch (e) {
            console.warn('[copc] region 캐시 insert 실패:', e); // 조용한 실패 방지(표면화)
          }
        },
        () => {}, // base() 거부는 consumer 가 await p 로 처리 — 여기선 unhandled 경고만 억제
      ).finally(() => inflight.delete(run.start));
    }
    const region = await p; // 공유 region bytes
    return region.slice(begin - run.start, end - run.start); // 복사본
  };
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
      if (bytes.length > maxBytes) return; // 캐시 전체보다 큰 region 은 보관 안 함 — cap 엄수
      regions.push({ start, end, bytes: new Uint8Array(bytes) }); // 복사본 저장
      total += bytes.length;
      while (total > maxBytes && regions.length > 1) {
        const evicted = regions.shift()!; // LRU
        total -= evicted.bytes.length;
      }
    },
  };
}
