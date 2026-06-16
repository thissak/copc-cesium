import { Copc, Getter, Hierarchy } from 'copc';
import proj4 from 'proj4';
import type { LazPerf } from 'laz-perf/lib/web';

// 순수 데이터 파이프라인 — Cesium/브라우저 무관. Node 에서도 그대로 돈다.
// (Giro3D 의 source/entity 분리와 동일: 여기는 source = fetch + decode + reproject)

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
  const getter = Getter.http(url);

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
  toWgs?: Reproj;
  zUnit: number;
  cube: number[]; // [minx,miny,minz,maxx,maxy,maxz] (root, 큐브)
  spacing: number;
}

/** COPC 를 열어 헤더 + 옥트리(루트 페이지) + 좌표변환을 준비 (스트리밍 세션). */
export async function openCopc(url: string): Promise<CopcSession> {
  const getter = Getter.http(url);
  const copc = await Copc.create(getter);
  const { nodes } = await Copc.loadHierarchyPage(getter, copc.info.rootHierarchyPage);
  const horiz = copc.wkt ? extractHorizontalCrs(copc.wkt) : undefined;
  const toWgs = horiz ? (proj4(horiz.proj, proj4.WGS84) as unknown as Reproj) : undefined;
  return {
    copc,
    getter,
    nodes,
    toWgs,
    zUnit: horiz ? horiz.linearUnit : 1,
    cube: copc.info.cube,
    spacing: copc.info.spacing,
  };
}

/** 한 노드(key='D-X-Y-Z')의 모든 점을 디코드해 경위도+높이로 반환. 없으면 null. */
export async function decodeNode(
  s: CopcSession,
  key: string,
  lazPerf?: LazPerf,
): Promise<{ lonLatH: number[]; zVals: number[]; count: number } | null> {
  const node = s.nodes[key];
  if (!node) return null;
  const view = await Copc.loadPointDataView(s.getter, s.copc, node, lazPerf ? { lazPerf } : undefined);
  const gx = view.getter('X');
  const gy = view.getter('Y');
  const gz = view.getter('Z');
  const lonLatH: number[] = [];
  const zVals: number[] = [];
  for (let i = 0; i < view.pointCount; i++) {
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
  }
  return { lonLatH, zVals, count: view.pointCount };
}
