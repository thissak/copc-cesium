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
