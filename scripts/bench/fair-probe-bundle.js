"use strict";
var FairProbe = (() => {
  var __defProp = Object.defineProperty;
  var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
  var __getOwnPropNames = Object.getOwnPropertyNames;
  var __hasOwnProp = Object.prototype.hasOwnProperty;
  var __export = (target, all) => {
    for (var name in all)
      __defProp(target, name, { get: all[name], enumerable: true });
  };
  var __copyProps = (to, from, except, desc) => {
    if (from && typeof from === "object" || typeof from === "function") {
      for (let key of __getOwnPropNames(from))
        if (!__hasOwnProp.call(to, key) && key !== except)
          __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
    }
    return to;
  };
  var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

  // scripts/bench/fair-probe.ts
  var fair_probe_exports = {};
  __export(fair_probe_exports, {
    assertConfig: () => assertConfig,
    findTilesetIndex: () => findTilesetIndex,
    measureLoadCurve: () => measureLoadCurve,
    normalizeConfig: () => normalizeConfig,
    readConfig: () => readConfig,
    readStats: () => readStats,
    reassertConfig: () => reassertConfig,
    setCacheBytes: () => setCacheBytes,
    setMsse: () => setMsse,
    setViewpoint: () => setViewpoint
  });
  var W = () => window;
  function findTilesetIndex() {
    const v = W().viewer;
    if (!v?.scene?.primitives) return -1;
    const pr = v.scene.primitives;
    for (let i = 0; i < pr.length; i++) {
      const p = pr.get(i);
      if (p && (/Cesium3DTileset/.test(p?.constructor?.name) || typeof p?.maximumScreenSpaceError === "number")) return i;
    }
    return -1;
  }
  function readConfig(idx) {
    const v = W().viewer;
    const ts = v.scene.primitives.get(idx);
    const pcs = ts.pointCloudShading || {};
    const c = v.canvas || document.querySelector("canvas");
    return {
      edl: !!pcs.eyeDomeLighting,
      attenuation: !!pcs.attenuation,
      resolutionScale: v.resolutionScale ?? 1,
      canvasW: c?.width ?? 0,
      canvasH: c?.height ?? 0,
      globeShow: v.scene.globe ? !!v.scene.globe.show : false
    };
  }
  var NORM = { resolutionScale: 1, canvasW: 1600, canvasH: 900 };
  function normalizeConfig(idx) {
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
  function reassertConfig(idx) {
    const v = W().viewer;
    const ts = v.scene.primitives.get(idx);
    if (v.scene.globe?.show) v.scene.globe.show = false;
    if (ts.pointCloudShading) {
      if (ts.pointCloudShading.eyeDomeLighting) ts.pointCloudShading.eyeDomeLighting = false;
      if (ts.pointCloudShading.attenuation) ts.pointCloudShading.attenuation = false;
    }
  }
  function assertConfig(idx) {
    const c = readConfig(idx);
    return c.edl === false && c.attenuation === false && c.globeShow === false && c.resolutionScale === NORM.resolutionScale;
  }
  function readStats(idx) {
    const v = W().viewer;
    const ts = v.scene.primitives.get(idx);
    const st = ts.statistics || {};
    const m = performance.memory;
    return {
      pointsSelected: st.numberOfPointsSelected || 0,
      tilesReady: st.numberOfTilesWithContentReady || 0,
      pending: st.numberOfPendingRequests || 0,
      heapMB: m ? m.usedJSHeapSize / 1048576 : 0,
      cesiumMB: ts.totalMemoryUsageInBytes / 1048576
    };
  }
  function setViewpoint(idx, factor = 0.15) {
    const v = W().viewer;
    const ts = v.scene.primitives.get(idx);
    const bs = ts.boundingSphere;
    const sph = bs.clone();
    sph.radius = bs.radius * factor;
    v.camera.flyToBoundingSphere(sph, { duration: 0 });
    v.scene.requestRender();
  }
  function setMsse(idx, msse) {
    const v = W().viewer;
    v.scene.primitives.get(idx).maximumScreenSpaceError = msse;
  }
  function setCacheBytes(idx, mb) {
    if (mb <= 0) return;
    const ts = W().viewer.scene.primitives.get(idx);
    const bytes = mb * 1048576;
    ts.cacheBytes = bytes;
    ts.maximumCacheOverflowBytes = bytes;
  }
  async function measureLoadCurve(idx, msse, capMs, bucketSize, reassert) {
    const v = W().viewer;
    const ts = v.scene.primitives.get(idx);
    const s = (d) => new Promise((r) => setTimeout(r, d));
    const gl = (v.canvas || document.querySelector("canvas"))?.getContext("webgl2");
    const ext = gl ? gl.getExtension("EXT_disjoint_timer_query_webgl2") : null;
    ts.maximumScreenSpaceError = msse;
    const buckets = /* @__PURE__ */ new Map();
    const inflight = [];
    let active = null;
    let activePts = 0;
    let disjoint = false;
    const onPre = () => {
      if (!ext || active) return;
      active = gl.createQuery();
      activePts = readStats(idx).pointsSelected;
      gl.beginQuery(ext.TIME_ELAPSED_EXT, active);
    };
    const onPost = () => {
      if (ext && active) {
        gl.endQuery(ext.TIME_ELAPSED_EXT);
        inflight.push({ q: active, pts: activePts });
        active = null;
      }
      if (!ext) return;
      if (gl.getParameter(ext.GPU_DISJOINT_EXT)) {
        disjoint = true;
        inflight.length = 0;
        return;
      }
      for (let i = inflight.length - 1; i >= 0; i--) {
        const { q, pts } = inflight[i];
        if (gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE)) {
          const ms = gl.getQueryParameter(q, gl.QUERY_RESULT) / 1e6;
          const key = Math.round(pts / bucketSize) * bucketSize;
          if (!buckets.has(key)) buckets.set(key, []);
          buckets.get(key).push(ms);
          gl.deleteQuery(q);
          inflight.splice(i, 1);
        }
      }
    };
    v.scene.preRender.addEventListener(onPre);
    v.scene.postRender.addEventListener(onPost);
    const t0 = performance.now();
    let prevPts = -1, plateau = 0;
    while (performance.now() - t0 < capMs) {
      if (reassert) reassertConfig(idx);
      v.scene.requestRender();
      await s(50);
      const pts = readStats(idx).pointsSelected;
      if (pts === prevPts) {
        plateau += 50;
        if (plateau >= 5e3) break;
      } else {
        plateau = 0;
        prevPts = pts;
      }
    }
    await s(200);
    v.scene.preRender.removeEventListener(onPre);
    v.scene.postRender.removeEventListener(onPost);
    const med = (a) => {
      const x = [...a].sort((m, n) => m - n);
      return +x[Math.floor(x.length / 2)].toFixed(3);
    };
    const curve = [...buckets.entries()].map(([pts, arr]) => ({ pts, gpuMs: med(arr), n: arr.length })).filter((b) => b.n >= 3).sort((a, b) => a.pts - b.pts);
    return { curve, gpuOk: !!ext && !disjoint && curve.length > 0, gpuDisjoint: disjoint, finalPts: prevPts };
  }
  return __toCommonJS(fair_probe_exports);
})();
window.FairProbe=FairProbe;
