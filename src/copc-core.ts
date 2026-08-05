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
  crsOpts: CrsOpts = {},
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

  // 좌표계: resolveCrs(crs>wkt>defaultCrs) → WGS84 변환. 실제 point bbox 중심 sanity 가드.
  const wkt = copc.wkt;
  const { toWgs, zUnit } = resolveCrs(wkt, crsOpts);
  checkCenterInRange(toWgs, [...copc.header.min, ...copc.header.max]);
  const reproj = makeGridReprojector(toWgs, copc.header.min, copc.header.max); // 이슈 #17

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
      const out = reproj.forward(x, y);
      lonLatH.push(out[0], out[1], z);
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
function extractBracketed(wkt: string, keywords: string[]): string | undefined {
  let start = -1;
  for (const keyword of keywords) {
    const i = wkt.indexOf(`${keyword}[`);
    if (i >= 0 && (start < 0 || i < start)) start = i;
  }
  if (start < 0) return undefined;
  const bracket = wkt.indexOf('[', start);
  let depth = 0;
  for (let i = bracket; i < wkt.length; i++) {
    if (wkt[i] === '[') depth++;
    else if (wkt[i] === ']' && --depth === 0) return wkt.slice(start, i + 1);
  }
  return undefined;
}

function lastLinearUnit(def: string): number | undefined {
  const units = [...def.matchAll(/(?:LENGTHUNIT|UNIT)\["[^"]*",\s*([0-9.eE+-]+)/g)];
  return units.length ? Number(units[units.length - 1][1]) : undefined;
}

function projStringUnit(def: string): number | undefined {
  return namedProjStringUnit(def, 'units', 'to_meter');
}

function namedProjStringUnit(def: string, unitsKey: string, factorKey: string): number | undefined {
  const units = new RegExp(`(?:^|\\s)\\+${unitsKey}=([^\\s]+)`).exec(def)?.[1];
  if (units === 'm') return 1;
  if (units === 'ft') return 0.3048;
  if (units === 'us-ft') return 1200 / 3937;
  const toMeter = new RegExp(`(?:^|\\s)\\+${factorKey}=([0-9.eE+-]+)`).exec(def)?.[1];
  return toMeter ? Number(toMeter) : undefined;
}

export function extractHorizontalCrs(wkt: string): { proj: string; linearUnit: number } {
  let proj = wkt;
  const projected = extractBracketed(wkt, ['PROJCS', 'PROJCRS']);
  const geographic = extractBracketed(wkt, ['GEOGCS', 'GEOGCRS', 'GEOGRAPHICCRS']);
  const horizontal = projected ?? geographic;
  if (horizontal && /^(?:COMPD_CS|COMPOUNDCRS)\[/.test(wkt)) proj = horizontal;
  const linearUnit = (projected ? lastLinearUnit(projected) : projStringUnit(proj)) ?? 1;
  return { proj, linearUnit };
}

/** Compound CRS의 수직 CRS 단위를 우선하고, 없으면 수평 선형단위를 폴백한다. */
export function extractVerticalUnit(wkt: string, horizontalUnit: number): number {
  const vertical = extractBracketed(wkt, ['VERT_CS', 'VERTCRS', 'VERTICALCRS']);
  return (vertical ? lastLinearUnit(vertical) : undefined) ??
    namedProjStringUnit(wkt, 'vunits', 'vto_meter') ?? horizontalUnit;
}

export type CrsOpts = { crs?: string; defaultCrs?: string };

/**
 * CRS 를 우선순위로 해소해 WGS84 변환을 만든다 (PDAL 2-mode).
 *   opts.crs(force) > wkt(header) > opts.defaultCrs(fill-if-missing) > 없음→throw.
 * proj4 입력은 proj4 string / WKT 1급, EPSG 코드는 proj4 내장분만. 파싱 불가/미해결은 throw(조용한 오배치 방지).
 * 높이(Z)는 선형단위만 보정한 ellipsoidal(HAE)로 취급 — geoid/정사고(orthometric) 보정 안 함
 * (web-viewer 업계 norm: Potree·giro3d·py3dtiles 동일). orthometric 입력은 수십 m 수직 오프셋 가능.
 */
export function resolveCrs(wkt: string | undefined, opts: CrsOpts = {}): {
  toWgs: Reproj;
  horizontalUnit: number;
  horizontalIsAngular: boolean;
  zUnit: number;
} {
  const def = opts.crs ?? wkt ?? opts.defaultCrs;
  if (!def) {
    throw new Error(
      'COPC has no embedded CRS (no WKT). Pass a CRS via the `crs` option ' +
        "(proj4 string / WKT / built-in EPSG), or `defaultCrs` to fill when the file omits one.",
    );
  }
  const horiz = extractHorizontalCrs(def);
  let toWgs: Reproj;
  let horizontalIsAngular: boolean;
  try {
    const sourceProjection = new proj4.Proj(horiz.proj) as unknown as { projName?: string };
    horizontalIsAngular = sourceProjection.projName === 'longlat';
    toWgs = proj4(horiz.proj, proj4.WGS84) as unknown as Reproj;
    if (typeof toWgs.forward !== 'function') throw new Error('no forward()');
  } catch (e) {
    throw new Error(
      `CRS parse failed for "${String(def).slice(0, 60)}…" — pass a valid proj4 string or WKT ` +
        `via the \`crs\` option. (${(e as Error).message})`,
    );
  }
  return {
    toWgs,
    horizontalUnit: horiz.linearUnit,
    horizontalIsAngular,
    zUnit: extractVerticalUnit(def, horiz.linearUnit),
  };
}

/**
 * reproject 정합 가드: cube 중심을 1회 변환해 lon/lat 가 유효 범위인지 확인.
 * 범위 밖/NaN 이면 throw — 잘못된 CRS·축 뒤집힘(거울상)·out-of-domain 을 점 루프 진입 전 조기 차단.
 */
export function checkCenterInRange(toWgs: Reproj, cube: number[]): void {
  const cx = (cube[0] + cube[3]) / 2;
  const cy = (cube[1] + cube[4]) / 2;
  const [lon, lat] = toWgs.forward([cx, cy]);
  if (!(Number.isFinite(lon) && Number.isFinite(lat) && lon >= -180 && lon <= 180 && lat >= -90 && lat <= 90)) {
    throw new Error(
      `CRS reproject out of range (lon=${lon}, lat=${lat}) — likely wrong CRS or swapped axis order. ` +
        'Pass the correct CRS via the `crs` option.',
    );
  }
}

// ── 스트리밍 세션 (Phase 2 본편) ───────────────────────────────────────
type Reproj = { forward: (coord: number[]) => number[]; inverse?: (coord: number[]) => number[] };

/**
 * bounded-extent reproject 가속기 (이슈 #17). 점별 proj4 가 deep-load 내부 compute 의 ~50% →
 * 데이터 bbox 위 (G+1)² proj4 control 격자 + 점별 bilinear 보간으로 점당 투영수학을 제거(실측 46~68× / sub-mm).
 * 셀중심(=bilinear 최대오차 지점)서 proj4 대비 max 오차를 재 임계(기본 ~1mm) 충족까지 G 를 키우고, 못 맞추면
 * (대형 extent·비정상 CRS) proj4 per-point 로 폴백 → 범용 정확성 보존. 격자는 데이터셋당 1회 빌드.
 * forward(x,y)=신규 [lon,lat](공유 가변상태 없음 → 동시 디코드 안전).
 */
export interface GridReproj {
  forward(x: number, y: number): [number, number];
}
export function makeGridReprojector(
  toWgs: Reproj,
  min: number[],
  max: number[],
  opts: { maxErrDeg?: number; gridStart?: number; gridMax?: number } = {},
): GridReproj {
  const minx = min[0];
  const miny = min[1];
  const dx = max[0] - minx;
  const dy = max[1] - miny;
  const maxErrDeg = opts.maxErrDeg ?? 9e-9; // ≈1mm (위도 1도 ≈ 111.32km)
  const gridMax = opts.gridMax ?? 64;
  const proj: GridReproj['forward'] = (x, y) => {
    const o = toWgs.forward([x, y]);
    return [o[0], o[1]];
  };
  if (!(dx > 0) || !(dy > 0)) return { forward: proj }; // 퇴화(0폭) extent → 폴백

  for (let G = opts.gridStart ?? 8; G <= gridMax; G *= 2) {
    const W = G + 1;
    const lonG = new Float64Array(W * W);
    const latG = new Float64Array(W * W);
    for (let gy = 0; gy <= G; gy++)
      for (let gx = 0; gx <= G; gx++) {
        const o = toWgs.forward([minx + (gx / G) * dx, miny + (gy / G) * dy]);
        const k = gy * W + gx;
        lonG[k] = o[0];
        latG[k] = o[1];
      }
    // 셀당 다점(중심 + 4 모서리중점)서 proj4 대비 max 오차. bilinear 잔차 R~a·(u-u²)+b·(v-v²) 는
    // 동부호 곡률(a,b 동부호)이면 셀중심(0.5,0.5), 이부호(saddle)면 모서리중점(0.5,0)·(0,0.5)서 최대 →
    // 셀중심 단일 샘플은 saddle/방향성 곡률(LCC·tmerc)서 최대오차를 놓친다(dual-review #18 R1).
    const SAMP: ReadonlyArray<readonly [number, number]> = [
      [0.5, 0.5], [0.5, 0], [0.5, 1], [0, 0.5], [1, 0.5],
    ];
    let err = 0;
    for (let cy = 0; cy < G && err <= maxErrDeg; cy++)
      for (let cx = 0; cx < G && err <= maxErrDeg; cx++) {
        const i00 = cy * W + cx;
        const l00 = lonG[i00], l10 = lonG[i00 + 1], l01 = lonG[i00 + W], l11 = lonG[i00 + W + 1];
        const a00 = latG[i00], a10 = latG[i00 + 1], a01 = latG[i00 + W], a11 = latG[i00 + W + 1];
        for (const [u, v] of SAMP) {
          const wa = (1 - u) * (1 - v), wb = u * (1 - v), wc = (1 - u) * v, wd = u * v;
          const blon = wa * l00 + wb * l10 + wc * l01 + wd * l11;
          const blat = wa * a00 + wb * a10 + wc * a01 + wd * a11;
          const t = toWgs.forward([minx + ((cx + u) / G) * dx, miny + ((cy + v) / G) * dy]);
          const e = Math.max(Math.abs(blon - t[0]), Math.abs(blat - t[1]));
          if (e > err) err = e;
        }
      }
    if (err > maxErrDeg) continue; // 임계 초과 → 더 촘촘한 격자로 (또는 gridMax 후 proj4 폴백)
    const Gc = G;
    const Wc = W;
    return {
      forward(x, y) {
        const fx = ((x - minx) / dx) * Gc;
        const fy = ((y - miny) / dy) * Gc;
        let gx = fx | 0;
        let gy = fy | 0;
        if (gx < 0) gx = 0;
        else if (gx >= Gc) gx = Gc - 1;
        if (gy < 0) gy = 0;
        else if (gy >= Gc) gy = Gc - 1;
        const u = fx - gx;
        const v = fy - gy;
        const i00 = gy * Wc + gx;
        const a = (1 - u) * (1 - v);
        const b = u * (1 - v);
        const c = (1 - u) * v;
        const d = u * v;
        return [
          a * lonG[i00] + b * lonG[i00 + 1] + c * lonG[i00 + Wc] + d * lonG[i00 + Wc + 1],
          a * latG[i00] + b * latG[i00 + 1] + c * latG[i00 + Wc] + d * latG[i00 + Wc + 1],
        ];
      },
    };
  }
  return { forward: proj }; // gridMax 까지 임계 미달 → proj4 per-point 폴백 (정확성 보존)
}

export interface CopcSession {
  copc: Copc;
  getter: Getter;
  nodes: Hierarchy.Node.Map;
  /** 미로드 자식 하이어라키 페이지 포인터(key→{pageOffset,pageLength}). lazy 페이징용. */
  pages: Hierarchy.Page.Map;
  /** 동일 서브페이지의 동시 로드를 공유하는 세션 단위 single-flight registry. */
  pageLoads: Map<string, Promise<boolean>>;
  toWgs?: Reproj;
  /** reproject 가속기 (이슈 #17: 격자 bilinear, proj4 폴백). toWgs 있을 때만 설정. */
  reproj?: GridReproj;
  zUnit: number;
  /** 투영 source X/Y 선형단위의 미터 환산값. */
  horizontalUnit: number;
  /** source X/Y가 선형 투영 단위가 아니라 경도·위도 각도인지 여부. */
  horizontalIsAngular: boolean;
  cube: number[]; // [minx,miny,minz,maxx,maxy,maxz] (root, 큐브)
  spacing: number;
  /** root의 수평 WGS84 span과 수직 미터 span 중 큰 값. 3D Tiles geometricError 단위용. */
  rootSpanM: number;
}

const GEO_A = 6378137;
const GEO_F = 1 / 298.257223563;
const GEO_E2 = GEO_F * (2 - GEO_F);

function surfaceEcef(lonDeg: number, latDeg: number, heightM = 0): [number, number, number] {
  const lon = lonDeg * Math.PI / 180;
  const lat = latDeg * Math.PI / 180;
  const sinLat = Math.sin(lat);
  const cosLat = Math.cos(lat);
  const n = GEO_A / Math.sqrt(1 - GEO_E2 * sinLat * sinLat);
  return [
    (n + heightM) * cosLat * Math.cos(lon),
    (n + heightM) * cosLat * Math.sin(lon),
    (n * (1 - GEO_E2) + heightM) * sinLat,
  ];
}

/** source XY bbox 경계를 WGS84로 변환해 최대 수평 chord 길이(미터)를 구한다. */
export function horizontalSpanMeters(toWgs: Reproj, bounds: number[], segments = 8): number {
  const minX = bounds[0], minY = bounds[1], maxX = bounds[3], maxY = bounds[4];
  const distance = (a: number[], b: number[]): number => {
    const ea = surfaceEcef(a[0], a[1]);
    const eb = surfaceEcef(b[0], b[1]);
    return Math.hypot(ea[0] - eb[0], ea[1] - eb[1], ea[2] - eb[2]);
  };
  let maxDistance = 0;
  for (let i = 0; i <= segments; i++) {
    const t = i / segments;
    const x = minX + (maxX - minX) * t;
    const y = minY + (maxY - minY) * t;
    const bottom = toWgs.forward([x, minY]);
    const top = toWgs.forward([x, maxY]);
    const left = toWgs.forward([minX, y]);
    const right = toWgs.forward([maxX, y]);
    for (const ll of [bottom, top, left, right])
      if (!(Number.isFinite(ll[0]) && Number.isFinite(ll[1]))) throw new Error('CRS boundary reproject produced non-finite coordinates');
    maxDistance = Math.max(maxDistance, distance(bottom, top), distance(left, right));
  }
  return maxDistance;
}

/** COPC 를 열어 헤더 + 옥트리(루트 페이지) + 좌표변환을 준비 (스트리밍 세션). */
export async function openCopc(url: string, opts?: { coalesce?: CoalesceOpts } & CrsOpts): Promise<CopcSession> {
  const base = httpGetterWithRetry(url);
  const copc = await Copc.create(base); // 헤더는 base 로(비-노드)
  const { nodes, pages } = await Copc.loadHierarchyPage(base, copc.info.rootHierarchyPage); // 루트 hierarchy 도 base
  const { toWgs, horizontalUnit, horizontalIsAngular, zUnit } = resolveCrs(
    copc.wkt,
    { crs: opts?.crs, defaultCrs: opts?.defaultCrs },
  );
  checkCenterInRange(toWgs, [...copc.header.min, ...copc.header.max]);
  const horizontalSpanM = horizontalSpanMeters(toWgs, [...copc.header.min, ...copc.header.max]);
  const verticalSpanM = (copc.header.max[2] - copc.header.min[2]) * zUnit;
  const session: CopcSession = {
    copc,
    getter: base,
    nodes,
    pages,
    pageLoads: new Map(),
    toWgs,
    reproj: makeGridReprojector(toWgs, copc.header.min, copc.header.max),
    zUnit,
    horizontalUnit,
    horizontalIsAngular,
    cube: copc.info.cube,
    spacing: copc.info.spacing,
    rootSpanM: Math.max(horizontalSpanM, verticalSpanM),
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
  const existing = s.pageLoads.get(key);
  if (existing) return existing;
  // --8<-- [start:loadSubPage]
  const pending = (async () => {
    const sub = await Copc.loadHierarchyPage(s.getter, ptr);
    Object.assign(s.nodes, sub.nodes); // K 와 그 하위 실노드
    Object.assign(s.pages, sub.pages); // 더 깊은 미로드 페이지 포인터
    delete s.pages[key]; // 로드 완료 → 더는 미로드 포인터 아님
    return true;
  })();
  s.pageLoads.set(key, pending);
  try {
    return await pending;
  } finally {
    // 실패도 캐시하지 않는다. 포인터는 성공 시에만 지워지므로 다음 호출에서 재시도 가능하다.
    if (s.pageLoads.get(key) === pending) s.pageLoads.delete(key);
  }
  // --8<-- [end:loadSubPage]
}

/**
 * 씨앗(source CRS sx,sy,sz)을 포함하는 가장 깊은 *실재* 옥트리 노드 키 반환 (이슈 #3-B).
 * 루트부터 octant 로 하강하며 s.nodes 존재 확인, 미로드 서브페이지(s.pages)면 loadSubPage 후 재시도.
 * 씨앗이 루트 큐브 밖이거나 루트 노드 부재면 undefined.
 */
export async function locateDeepestNode(s: CopcSession, sx: number, sy: number, sz: number): Promise<string | undefined> {
  const c = s.cube; // [minx,miny,minz,maxx,maxy,maxz] (COPC 큐브)
  const cubeSide = c[3] - c[0];
  if (!(cubeSide > 0)) return undefined;
  if (sx < c[0] || sx > c[3] || sy < c[1] || sy > c[4] || sz < c[2] || sz > c[5]) return undefined;
  if (!s.nodes['0-0-0-0']) return undefined;
  let best = '0-0-0-0';
  let d = 0, x = 0, y = 0, z = 0;
  while (d < 32) {
    const sideD = cubeSide / 2 ** d; // 현재 노드(depth d) 한 변
    const half = sideD / 2; // 자식 한 변
    const ox = c[0] + x * sideD, oy = c[1] + y * sideD, oz = c[2] + z * sideD;
    const cx = sx >= ox + half ? 1 : 0;
    const cy = sy >= oy + half ? 1 : 0;
    const cz = sz >= oz + half ? 1 : 0;
    const childKey = `${d + 1}-${x * 2 + cx}-${y * 2 + cy}-${z * 2 + cz}`;
    if (s.pages[childKey]) await loadSubPage(s, childKey); // 미로드 서브페이지 → 로드
    if (!s.nodes[childKey]) return best; // 더 깊은 실재 노드 없음 → 현재가 가장 깊음
    best = childKey;
    d += 1; x = x * 2 + cx; y = y * 2 + cy; z = z * 2 + cz;
  }
  return best;
}

export interface NearestHit {
  lon: number;
  lat: number;
  height: number;
  dist: number; // 씨앗↔승자 거리(미터)
  attributes: Record<string, number>;
}

/** source 축 차분을 수평 source 단위계의 등방 거리 제곱으로 정규화한다. */
function sourceMetricSquared(
  dx: number,
  dy: number,
  dz: number,
  horizontalUnit: number,
  zUnit: number,
): number {
  const normalizedZ = dz * (zUnit / horizontalUnit);
  return dx * dx + dy * dy + normalizedZ * normalizedZ;
}

/** projected source 축 차분의 실제 미터 거리 제곱. */
export function sourceMetricMetersSquared(
  dx: number,
  dy: number,
  dz: number,
  horizontalUnit: number,
  zUnit: number,
): number {
  return sourceMetricSquared(dx, dy, dz, horizontalUnit, zUnit) * horizontalUnit * horizontalUnit;
}

/** 세션 CRS 종류에 따라 projected source metric 또는 geographic ECEF metric을 선택한다. */
export function sessionMetricMetersSquared(
  s: CopcSession,
  a: [number, number, number],
  b: [number, number, number],
): number {
  return makeSessionMetric(s, a)(b[0], b[1], b[2]);
}

/** 씨앗의 CRS 변환을 한 번만 수행하고 후보별 실제 미터 거리 제곱 함수를 만든다. */
export function makeSessionMetric(
  s: CopcSession,
  seed: [number, number, number],
): (x: number, y: number, z: number) => number {
  if (!s.horizontalIsAngular) {
    return (x, y, z) => sourceMetricMetersSquared(
      x - seed[0], y - seed[1], z - seed[2], s.horizontalUnit, s.zUnit,
    );
  }
  const forward = (x: number, y: number, z: number): [number, number, number] => {
    const ll = s.reproj ? s.reproj.forward(x, y) : s.toWgs!.forward([x, y]);
    return surfaceEcef(ll[0], ll[1], z * s.zUnit);
  };
  const ae = forward(seed[0], seed[1], seed[2]);
  return (x, y, z) => {
    const be = forward(x, y, z);
    return (be[0] - ae[0]) ** 2 + (be[1] - ae[1]) ** 2 + (be[2] - ae[2]) ** 2;
  };
}

/**
 * 노드(key) 안에서 씨앗(source sx,sy,sz)에 3D 최근접인 실제 점을 찾아 정확 좌표+속성 반환 (이슈 #3-B).
 * projected는 source metric, geographic은 후보별 격자 reproject→ECEF metric으로 비교한다.
 * hideClass 점은 스킵(렌더와 일관).
 * projected CRS는 Z 차분을 zUnit/horizontalUnit으로 정규화한 source metric을 사용한다.
 * geographic CRS는 각도에 상수 선형 환산을 적용할 수 없으므로 후보를 WGS84 ECEF로 변환해 비교한다.
 * 노드 없음/0점/전부 스킵 → null.
 */
export async function nearestPointInNode(
  s: CopcSession,
  key: string,
  sx: number,
  sy: number,
  sz: number,
  attrs: AttributeSpec[] | undefined,
  hideClass?: ReadonlySet<number>,
  lazPerf?: LazPerf,
): Promise<NearestHit | null> {
  const node = s.nodes[key];
  if (!node) return null;
  const view = await Copc.loadPointDataView(s.getter, s.copc, node, lazPerf ? { lazPerf } : undefined);
  const n = view.pointCount;
  if (n === 0) return null;
  const gx = view.getter('X');
  const gy = view.getter('Y');
  const gz = view.getter('Z');
  const gc = hideClass?.size && 'Classification' in view.dimensions ? view.getter('Classification') : null;
  let best = -1;
  let bestD2 = Infinity;
  const metric = makeSessionMetric(s, [sx, sy, sz]);
  for (let i = 0; i < n; i++) {
    if (gc && hideClass!.has(gc(i) | 0)) continue;
    const d2 = metric(gx(i), gy(i), gz(i));
    if (d2 < bestD2) { bestD2 = d2; best = i; }
  }
  if (best < 0) return null;
  const o = s.reproj ? s.reproj.forward(gx(best), gy(best)) : [gx(best), gy(best)];
  const attributes: Record<string, number> = {};
  if (attrs) for (const spec of attrs) attributes[spec.batchName] = view.getter(spec.lasName)(best);
  return { lon: o[0], lat: o[1], height: gz(best) * s.zUnit, dist: Math.sqrt(bestD2), attributes };
}

/**
 * WGS84 씨앗(lon°,lat°,height m)에 풀해상도 최근접 실제 점 (이슈 #3-B 합성 진입점).
 * 수평 역변환(toWgs.inverse)·수직 height/zUnit → source 씨앗 → 가장 깊은 노드 → 노드 내 최근접.
 * 역변환 불가/큐브 밖/노드 없음 → null.
 */
export async function nearestPoint(
  s: CopcSession,
  lon: number,
  lat: number,
  height: number,
  attrs: AttributeSpec[] | undefined,
  hideClass?: ReadonlySet<number>,
  lazPerf?: LazPerf,
): Promise<NearestHit | null> {
  if (!s.toWgs?.inverse) return null;
  const src = s.toWgs.inverse([lon, lat]);
  const sx = src[0];
  const sy = src[1];
  const sz = height / s.zUnit;
  if (!Number.isFinite(sx) || !Number.isFinite(sy) || !Number.isFinite(sz)) return null;
  const key = await locateDeepestNode(s, sx, sy, sz);
  if (!key) return null;
  return nearestPointInNode(s, key, sx, sy, sz, attrs, hideClass, lazPerf);
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
    if (s.reproj) {
      const o = s.reproj.forward(x, y); // 이슈 #17: 격자 bilinear (proj4 폴백 내장)
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
  // in-flight 는 run.start 로 dedup 하되, promise 는 fetch 한 region 의 실제 [start,end) 를 함께 resolve.
  // (이슈 #04) rebuild 로 run.end 가 커져도 슬라이스는 fetch 정체성 기준 → Arrow ReadRangeCache 패턴.
  const inflight = new Map<number, Promise<CachedRegion>>(); // run.start → 가져온 region {start,end,bytes}
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
      const rStart = run.start, rEnd = run.end; // 이 fetch 의 불변 정체성 스냅샷(rebuild 로 run 이 바뀌어도 고정)
      p = base(rStart, rEnd).then((bytes) => ({ start: rStart, end: rEnd, bytes }));
      inflight.set(rStart, p);
      p.then(
        (region) => {
          try {
            cache.insert(region.start, region.end, region.bytes);
          } catch (e) {
            console.warn('[copc] region 캐시 insert 실패:', e); // 조용한 실패 방지(표면화)
          }
        },
        () => {}, // base() 거부는 consumer 가 await p 로 처리 — 여기선 unhandled 경고만 억제
      ).finally(() => inflight.delete(rStart));
    }
    const region = await p; // { start, end, bytes } — fetch 한 실제 정체성
    // (이슈 #04) 슬라이스는 mutable run 이 아니라 fetch 한 region 의 [start,end) 기준(Arrow Contains→Slice).
    // rebuild 로 run.end 가 커졌는데 in-flight 가 옛(작은) region 이면 커버리지 미달 → 직접 fetch 폴백(정확성 우선).
    if (region.start <= begin && region.end >= end) {
      return region.bytes.slice(begin - region.start, end - region.start); // 복사본
    }
    return base(begin, end); // 레이스: in-flight region 이 이 노드를 안 덮음 → 직접 정확 fetch
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
