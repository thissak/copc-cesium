import { Cartesian3, Color } from 'cesium';
import { LazPerf } from 'laz-perf/lib/web';
// laz-perf 의 main 은 node 빌드라 Vite 가 wasm 경로를 못 잡는다.
// web 빌드를 쓰고, wasm 은 Vite 가 서빙하는 URL(?url)을 locateFile 로 명시 주입한다.
import lazPerfWasmUrl from 'laz-perf/lib/web/laz-perf.wasm?url';
import { loadCopcPoints } from './copc-core';

let lazPerfPromise: ReturnType<typeof LazPerf.create> | undefined;
function getLazPerf() {
  if (!lazPerfPromise) lazPerfPromise = LazPerf.create({ locateFile: () => lazPerfWasmUrl });
  return lazPerfPromise;
}

export interface NaiveLoadResult {
  positions: Cartesian3[];
  colors: Color[];
  pointCount: number;
  crsWkt: string | undefined;
  timings: { createMs: number; hierarchyMs: number; fetchDecodeMs: number; georefMs: number };
}

/** 브라우저 렌더 레이어: 순수 core 로 점을 받아 Cesium Cartesian3/Color 로 변환. */
export async function loadCopcNaive(url: string, pointBudget: number): Promise<NaiveLoadResult> {
  const lazPerf = await getLazPerf();
  const core = await loadCopcPoints(url, pointBudget, lazPerf);

  const t = performance.now();
  const positions = Cartesian3.fromDegreesArrayHeights(core.lonLatH);
  // 고도 램프 색 (RGB 가정 없이 항상 동작): 낮음=파랑 → 높음=빨강
  let zmin = Infinity;
  let zmax = -Infinity;
  for (const z of core.zVals) {
    if (z < zmin) zmin = z;
    if (z > zmax) zmax = z;
  }
  const span = zmax - zmin || 1;
  const colors = core.zVals.map((z) => Color.fromHsl((1 - (z - zmin) / span) * 0.66, 1.0, 0.5));
  const georefMs = performance.now() - t;

  return {
    positions,
    colors,
    pointCount: core.pointCount,
    crsWkt: core.crsWkt,
    timings: { ...core.timings, georefMs },
  };
}
