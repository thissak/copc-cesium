// scripts/bench/fair-probe.ts — 브라우저 주입(esbuild IIFE → global FairProbe)
import type { ConfigSnapshot } from './fair-types';

declare const window: any;
const W = () => window;

export function findTilesetIndex(): number {
  const v = W().viewer;
  if (!v?.scene?.primitives) return -1;
  const pr = v.scene.primitives;
  for (let i = 0; i < pr.length; i++) {
    const p = pr.get(i);
    if (p && (/Cesium3DTileset/.test(p?.constructor?.name) || typeof p?.maximumScreenSpaceError === 'number')) return i;
  }
  return -1;
}

export function readConfig(idx: number): ConfigSnapshot {
  const v = W().viewer;
  const ts = v.scene.primitives.get(idx);
  const pcs = ts.pointCloudShading || {};
  const c = v.canvas || document.querySelector('canvas');
  return {
    edl: !!pcs.eyeDomeLighting,
    attenuation: !!pcs.attenuation,
    resolutionScale: v.resolutionScale ?? 1,
    canvasW: c?.width ?? 0,
    canvasH: c?.height ?? 0,
    globeShow: v.scene.globe ? !!v.scene.globe.show : false,
  };
}

const NORM = { resolutionScale: 1, canvasW: 1600, canvasH: 900 };

export function normalizeConfig(idx: number): void {
  const v = W().viewer;
  const ts = v.scene.primitives.get(idx);
  if (v.scene.globe) v.scene.globe.show = false;
  if (v.imageryLayers?.removeAll) v.imageryLayers.removeAll();
  v.useBrowserRecommendedResolution = false;
  v.resolutionScale = NORM.resolutionScale;
  if (ts.pointCloudShading) {
    ts.pointCloudShading.eyeDomeLighting = false;
    ts.pointCloudShading.attenuation = false;
  }
}

// 매 프레임 재적용용 — Eptium 이 덮어쓰면 되돌린다
export function reassertConfig(idx: number): void {
  const v = W().viewer;
  const ts = v.scene.primitives.get(idx);
  if (v.scene.globe?.show) v.scene.globe.show = false;
  if (ts.pointCloudShading) {
    if (ts.pointCloudShading.eyeDomeLighting) ts.pointCloudShading.eyeDomeLighting = false;
    if (ts.pointCloudShading.attenuation) ts.pointCloudShading.attenuation = false;
  }
}

// readback 검증 — 정규화가 실제로 먹었나
export function assertConfig(idx: number): boolean {
  const c = readConfig(idx);
  return c.edl === false && c.attenuation === false && c.globeShow === false && c.resolutionScale === NORM.resolutionScale;
}

export function readStats(idx: number) {
  const v = W().viewer;
  const ts = v.scene.primitives.get(idx);
  const st = ts.statistics || {};
  const m = (performance as any).memory;
  return {
    pointsSelected: st.numberOfPointsSelected || 0,
    tilesReady: st.numberOfTilesWithContentReady || 0,
    pending: st.numberOfPendingRequests || 0,
    heapMB: m ? m.usedJSHeapSize / 1048576 : 0,
    cesiumMB: ts.totalMemoryUsageInBytes / 1048576,
  };
}

// 고정 깊은 시점 — 각 viewer bs 의 0.15배 반경으로 동일 비율 앵커.
// (동일 COPC → 동일 ECEF 중심. flyToBoundingSphere 대신 축소 sphere 로 결정적 깊이.)
export function setViewpoint(idx: number, factor = 0.15): void {
  const v = W().viewer;
  const ts = v.scene.primitives.get(idx);
  const bs = ts.boundingSphere;
  const sph = bs.clone();
  sph.radius = bs.radius * factor; // 0.15=깊은 줌(기본), 1.0=정상/원거리(C4 회귀 측정)
  v.camera.flyToBoundingSphere(sph, { duration: 0 });
  v.scene.requestRender();
}

export function setMsse(idx: number, msse: number): void {
  const v = W().viewer;
  v.scene.primitives.get(idx).maximumScreenSpaceError = msse;
}

// 이슈 #08 measure-first 게이트: Cesium 메모리예산(cacheBytes)으로 깊은 줌 점수를 유계화하는지 측정.
// mb<=0 이면 건드리지 않음(Cesium 기본 512MB 유지=무제한 baseline). overflow 도 같이 좁혀 memoryAdjustedSSE
// 자동조절을 가시화(demo soak/perf 와 동일 관례). LOD 손코딩 아님 — 네이티브 노브 설정일 뿐.
export function setCacheBytes(idx: number, mb: number): void {
  if (mb <= 0) return;
  const ts = W().viewer.scene.primitives.get(idx);
  const bytes = mb * 1048576;
  ts.cacheBytes = bytes;
  ts.maximumCacheOverflowBytes = bytes;
}

export async function measureLoadCurve(idx: number, msse: number, capMs: number, bucketSize: number, reassert: boolean) {
  const v = W().viewer;
  const ts = v.scene.primitives.get(idx);
  const s = (d: number) => new Promise((r) => setTimeout(r, d));
  const gl: any = (v.canvas || document.querySelector('canvas'))?.getContext('webgl2');
  const ext: any = gl ? gl.getExtension('EXT_disjoint_timer_query_webgl2') : null;
  ts.maximumScreenSpaceError = msse;

  const buckets = new Map<number, number[]>(); // bucketKey → gpuMs[]
  const inflight: { q: any; pts: number }[] = [];
  let active: any = null;
  let activePts = 0;
  let disjoint = false;
  const onPre = () => {
    if (!ext || active) return;
    active = gl.createQuery();
    activePts = readStats(idx).pointsSelected; // 이 프레임 렌더 시점의 점 수
    gl.beginQuery(ext.TIME_ELAPSED_EXT, active);
  };
  const onPost = () => {
    if (ext && active) { gl.endQuery(ext.TIME_ELAPSED_EXT); inflight.push({ q: active, pts: activePts }); active = null; }
    if (!ext) return;
    if (gl.getParameter(ext.GPU_DISJOINT_EXT)) { disjoint = true; inflight.length = 0; return; }
    for (let i = inflight.length - 1; i >= 0; i--) {
      const { q, pts } = inflight[i];
      if (gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE)) {
        const ms = gl.getQueryParameter(q, gl.QUERY_RESULT) / 1e6; // ns → ms
        const key = Math.round(pts / bucketSize) * bucketSize;
        if (!buckets.has(key)) buckets.set(key, []);
        buckets.get(key)!.push(ms);
        gl.deleteQuery(q); inflight.splice(i, 1);
      }
    }
  };
  v.scene.preRender.addEventListener(onPre);
  v.scene.postRender.addEventListener(onPost);

  const t0 = performance.now();
  let prevPts = -1, plateau = 0;
  while (performance.now() - t0 < capMs) {
    if (reassert) reassertConfig(idx); // Eptium 매프레임 덮어쓰기 방어
    v.scene.requestRender();
    await s(50);
    const pts = readStats(idx).pointsSelected;
    if (pts === prevPts) { plateau += 50; if (plateau >= 5000) break; } // 5s 정지 = 로드 완료 → 조기 종료
    else { plateau = 0; prevPts = pts; }
  }
  await s(200); // 잔여 query 드레인
  v.scene.preRender.removeEventListener(onPre);
  v.scene.postRender.removeEventListener(onPost);

  const med = (a: number[]) => { const x = [...a].sort((m, n) => m - n); return +x[Math.floor(x.length / 2)].toFixed(3); };
  const curve = [...buckets.entries()]
    .map(([pts, arr]) => ({ pts, gpuMs: med(arr), n: arr.length }))
    .filter((b) => b.n >= 3) // 버킷당 최소 3 프레임
    .sort((a, b) => a.pts - b.pts);
  return { curve, gpuOk: !!ext && !disjoint && curve.length > 0, gpuDisjoint: disjoint, finalPts: prevPts };
}
