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
export function setViewpoint(idx: number): void {
  const v = W().viewer;
  const ts = v.scene.primitives.get(idx);
  const bs = ts.boundingSphere;
  const sph = bs.clone();
  sph.radius = bs.radius * 0.15;
  v.camera.flyToBoundingSphere(sph, { duration: 0 });
  v.scene.requestRender();
}

export function setMsse(idx: number, msse: number): void {
  const v = W().viewer;
  v.scene.primitives.get(idx).maximumScreenSpaceError = msse;
}

// 완전정착: tilesReady ∧ pointsSelected 안정 3s; pending 미게이트
// (SW 파이프라인이 pending 을 영구 non-zero 로 유지 — #03 processing stuck 과 동형;
//  render-finality 신호는 pointsSelected/tilesReady 안정성). cap 도달 시 settled=false.
export async function settleFull(idx: number, capMs: number): Promise<{ settleMs: number; settled: boolean }> {
  const v = W().viewer;
  const s = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const t0 = performance.now();
  let prevR = -1, prevP = -1, stable = 0;
  while (performance.now() - t0 < capMs) {
    v.scene.requestRender();
    await s(200);
    const st = readStats(idx);
    if (st.tilesReady > 0 && st.tilesReady === prevR && st.pointsSelected === prevP) {
      stable += 200;
      if (stable >= 3000) return { settleMs: Math.round(performance.now() - t0 - stable), settled: true };
    } else { stable = 0; prevR = st.tilesReady; prevP = st.pointsSelected; }
  }
  return { settleMs: capMs, settled: false };
}
