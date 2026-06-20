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
