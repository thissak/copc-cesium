import type { CopcSession } from './copc-core';

// COPC 옥트리 → 3D Tiles tileset.json. 노드 1개 = 타일 1개.
// boundingVolume 은 region([W,S,E,N,minH,maxH] 라디안/미터) — ECEF 변환 불필요(proj4만).
// geometricError = spacing / 2^깊이 (미터). content 는 contentBase/{key}.pnts → SW가 가로채 노드 디코드.

const D2R = Math.PI / 180;

function nodeRegionAndError(s: CopcSession, key: string): { region: number[]; geomError: number } {
  const parts = key.split('-').map(Number);
  const d = parts[0];
  const x = parts[1];
  const y = parts[2];
  const z = parts[3];
  const side = (s.cube[3] - s.cube[0]) / 2 ** d; // 루트 큐브 한 변(투영단위)
  const minX = s.cube[0] + x * side;
  const minY = s.cube[1] + y * side;
  const c1 = s.toWgs ? s.toWgs.forward([minX, minY]) : [minX, minY];
  const c2 = s.toWgs ? s.toWgs.forward([minX + side, minY + side]) : [minX + side, minY + side];
  const west = Math.min(c1[0], c2[0]) * D2R;
  const east = Math.max(c1[0], c2[0]) * D2R;
  const south = Math.min(c1[1], c2[1]) * D2R;
  const north = Math.max(c1[1], c2[1]) * D2R;
  // 세로(높이)는 큐브가 과하게 크다 → 실제 데이터 Z 범위와 교집합으로 조임 (SSE 정확도↑ → LOD 일관성↑)
  const cubeMinZ = s.cube[2] + z * side;
  let minH = Math.max(cubeMinZ, s.copc.header.min[2]) * s.zUnit;
  let maxH = Math.min(cubeMinZ + side, s.copc.header.max[2]) * s.zUnit;
  if (maxH <= minH) maxH = minH + 1;
  const spacingM = s.spacing * s.zUnit;
  return { region: [west, south, east, north, minH, maxH], geomError: spacingM / 2 ** d };
}

function childKeys(s: CopcSession, key: string): string[] {
  const parts = key.split('-').map(Number);
  const d = parts[0];
  const x = parts[1];
  const y = parts[2];
  const z = parts[3];
  const out: string[] = [];
  for (let i = 0; i < 8; i++) {
    const ck = `${d + 1}-${x * 2 + (i & 1)}-${y * 2 + ((i >> 1) & 1)}-${z * 2 + ((i >> 2) & 1)}`;
    if (s.nodes[ck]) out.push(ck);
  }
  return out;
}

function buildNode(s: CopcSession, key: string, contentBase: string): object {
  const { region, geomError } = nodeRegionAndError(s, key);
  return {
    boundingVolume: { region },
    geometricError: geomError,
    refine: 'ADD',
    content: { uri: contentBase + key + '.pnts' },
    children: childKeys(s, key).map((ck) => buildNode(s, ck, contentBase)),
  };
}

/** 옥트리 → tileset.json. content 는 contentBase + 'D-X-Y-Z.pnts'. */
export function buildTileset(s: CopcSession, contentBase: string): object {
  const spacingM = s.spacing * s.zUnit;
  return {
    asset: { version: '1.0' },
    geometricError: spacingM * 2,
    root: buildNode(s, '0-0-0-0', contentBase),
  };
}
