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
    normalizeConfig: () => normalizeConfig,
    readConfig: () => readConfig,
    reassertConfig: () => reassertConfig
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
  return __toCommonJS(fair_probe_exports);
})();
window.FairProbe=FairProbe;
