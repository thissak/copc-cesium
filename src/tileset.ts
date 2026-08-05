import type { CopcSession } from './copc-core';

// COPC 옥트리 → 3D Tiles tileset.json. 노드 1개 = 타일 1개.
// boundingVolume 은 region([W,S,E,N,minH,maxH] 라디안/미터) — ECEF 변환 불필요(proj4만).
// geometricError = root metric span/16/2^깊이 (수평 WGS84 span·수직 미터 span의 최대).
// content 는 contentBase/{key}.pnts → SW가 가로채 노드 디코드.

const D2R = Math.PI / 180;

function longitudeBounds(values: number[]): [number, number] {
  const normalized = values.map((v) => ((v + 180) % 360 + 360) % 360 - 180).sort((a, b) => a - b);
  if (normalized.length === 1) return [normalized[0], normalized[0]];
  let gapIndex = normalized.length - 1;
  let largestGap = normalized[0] + 360 - normalized[normalized.length - 1];
  for (let i = 0; i < normalized.length - 1; i++) {
    const gap = normalized[i + 1] - normalized[i];
    if (gap > largestGap) { largestGap = gap; gapIndex = i; }
  }
  return [normalized[(gapIndex + 1) % normalized.length], normalized[gapIndex]];
}

/** source XY 사각형의 변을 샘플링해 비선형 투영에서도 보수적인 WGS84 region을 만든다. */
function horizontalRegion(
  s: CopcSession,
  minX: number,
  minY: number,
  maxX: number,
  maxY: number,
): [number, number, number, number] {
  const lons: number[] = [];
  const lats: number[] = [];
  const segments = 8;
  for (let i = 0; i <= segments; i++) {
    const t = i / segments;
    const x = minX + (maxX - minX) * t;
    const y = minY + (maxY - minY) * t;
    for (const xy of [[x, minY], [x, maxY], [minX, y], [maxX, y]]) {
      const ll = s.toWgs ? s.toWgs.forward(xy) : xy;
      if (!(Number.isFinite(ll[0]) && Number.isFinite(ll[1]) && ll[1] >= -90 && ll[1] <= 90))
        throw new Error(`tile region reproject out of range (lon=${ll[0]}, lat=${ll[1]})`);
      lons.push(ll[0]);
      lats.push(ll[1]);
    }
  }
  const [west, east] = longitudeBounds(lons);
  return [west * D2R, Math.min(...lats) * D2R, east * D2R, Math.max(...lats) * D2R];
}

function nodeRegionAndError(s: CopcSession, key: string): { region: number[]; geomError: number } {
  const parts = key.split('-').map(Number);
  const d = parts[0];
  const x = parts[1];
  const y = parts[2];
  const z = parts[3];
  const side = (s.cube[3] - s.cube[0]) / 2 ** d; // 루트 큐브 한 변(투영단위)
  const minX = s.cube[0] + x * side;
  const minY = s.cube[1] + y * side;
  // info.cube는 모든 축에 같은 radius를 쓰므로 geographic CRS에서는 Z(m)가 X/Y(°)를
  // 수백 도까지 팽창시킬 수 있다. 실제 점 bbox와 교집합해 source XY를 보수적으로 조인다.
  const boundedMinX = Math.max(minX, s.copc.header.min[0]);
  const boundedMinY = Math.max(minY, s.copc.header.min[1]);
  const boundedMaxX = Math.min(minX + side, s.copc.header.max[0]);
  const boundedMaxY = Math.min(minY + side, s.copc.header.max[1]);
  const intersectsHeader = boundedMaxX >= boundedMinX && boundedMaxY >= boundedMinY;
  const [west, south, east, north] = horizontalRegion(
    s,
    intersectsHeader ? boundedMinX : minX,
    intersectsHeader ? boundedMinY : minY,
    intersectsHeader ? boundedMaxX : minX + side,
    intersectsHeader ? boundedMaxY : minY + side,
  );
  // 세로(높이)는 큐브가 과하게 크다 → 실제 데이터 Z 범위와 교집합으로 조임 (SSE 정확도↑ → LOD 일관성↑)
  const cubeMinZ = s.cube[2] + z * side;
  let minH = Math.max(cubeMinZ, s.copc.header.min[2]) * s.zUnit;
  let maxH = Math.min(cubeMinZ + side, s.copc.header.max[2]) * s.zUnit;
  if (maxH <= minH) maxH = minH + 1;
  // --8<-- [start:geomError]
  const rootGE = s.rootSpanM / 16; // 수평·수직 중 큰 실제 미터 span. 수직형 데이터도 refine 보존.
  return { region: [west, south, east, north, minH, maxH], geomError: rootGE / 2 ** d };
  // --8<-- [end:geomError]
}

function childKeys(s: CopcSession, key: string): string[] {
  const parts = key.split('-').map(Number);
  const d = parts[0];
  const x = parts[1];
  const y = parts[2];
  const z = parts[3];
  const out: string[] = [];
  for (let i = 0; i < 8; i++) {
    // --8<-- [start:childKeys]
    const ck = `${d + 1}-${x * 2 + (i & 1)}-${y * 2 + ((i >> 1) & 1)}-${z * 2 + ((i >> 2) & 1)}`;
    // --8<-- [end:childKeys]
    if (s.nodes[ck] || s.pages[ck]) out.push(ck); // 로드된 노드 OR 미로드 서브페이지
  }
  return out;
}

// 미로드 서브페이지 K → 외부 tileset(page/K.json)을 가리키는 proxy 자식 타일(점 없음).
// Cesium 이 refine 시 그 JSON 을 요청 → SW→페이지가 서브페이지 로드해 K 의 실제 서브트리를 공급.
function pageProxy(s: CopcSession, key: string, contentBase: string): object {
  const { region, geomError } = nodeRegionAndError(s, key);
  return {
    boundingVolume: { region },
    geometricError: geomError,
    refine: 'ADD',
    content: { uri: contentBase + 'page/' + key + '.json' },
  };
}

function buildNode(s: CopcSession, key: string, contentBase: string): object {
  const { region, geomError } = nodeRegionAndError(s, key);
  const children = childKeys(s, key).map((ck) =>
    s.pages[ck] ? pageProxy(s, ck, contentBase) : buildNode(s, ck, contentBase),
  );
  // --8<-- [start:buildNode]
  return {
    boundingVolume: { region },
    geometricError: geomError,
    refine: 'ADD',
    content: { uri: contentBase + key + '.pnts' },
    children,
  };
  // --8<-- [end:buildNode]
}

/** 옥트리(루트 페이지) → tileset.json. content 는 contentBase + 'D-X-Y-Z.pnts'. */
export function buildTileset(s: CopcSession, contentBase: string): object {
  const rootGE = s.rootSpanM / 16;
  return {
    asset: { version: '1.0' },
    geometricError: rootGE * 2,
    root: buildNode(s, '0-0-0-0', contentBase),
  };
}

/** 서브페이지 root(rootKey)부터의 child tileset.json (page-proxy 요청 시 온디맨드 공급). */
export function buildSubtree(s: CopcSession, rootKey: string, contentBase: string): object {
  const { geomError } = nodeRegionAndError(s, rootKey);
  return {
    asset: { version: '1.0' },
    geometricError: geomError, // 부모 proxy 의 GE 와 연속 (Cesium merged-parent 규칙)
    root: buildNode(s, rootKey, contentBase),
  };
}
