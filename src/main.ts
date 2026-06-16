import {
  Viewer,
  Ion,
  PointPrimitiveCollection,
  BoundingSphere,
  Cartographic,
  Cartesian3,
  Math as CesiumMath,
  Cesium3DTileset,
} from 'cesium';
import 'cesium/Build/Cesium/Widgets/widgets.css';
import { loadCopcNaive } from './copc';
import { DATASETS } from './datasets';
import { buildPnts, toBase64 } from './pnts';

// 자체 ion 토큰이 있으면 .env 의 VITE_CESIUM_ION_TOKEN 로 주입 (없으면 Cesium 기본 dev 토큰).
const ionToken = import.meta.env.VITE_CESIUM_ION_TOKEN;
if (ionToken) Ion.defaultAccessToken = ionToken;

const viewer = new Viewer('app', {
  timeline: false,
  animation: false,
  geocoder: false,
  baseLayerPicker: false,
});
viewer.scene.debugShowFramesPerSecond = true; // ④ 렌더 (좌상단)
(window as unknown as { viewer: Viewer }).viewer = viewer; // 디버깅용 핸들

// 측정 HUD
const hud = document.createElement('div');
hud.style.cssText =
  'position:absolute;top:8px;left:8px;z-index:999;background:rgba(0,0,0,.72);color:#fff;' +
  'font:12px/1.55 ui-monospace,monospace;padding:9px 11px;border-radius:6px;max-width:380px;white-space:pre-wrap';
document.body.appendChild(hud);
const log = (s: string) => {
  hud.textContent = s;
  console.info(s);
};

// Phase 1 baseline 범위: naive 직접 로드, LOD 없음. (docs/PROBLEM.md)
const POINT_BUDGET = 100_000;
const ds = DATASETS[0]; // autzen — 소형, 정확성(C1) 먼저

async function run() {
  log(`로딩: ${ds.label}\n${ds.url}\nbudget ${POINT_BUDGET.toLocaleString()} pts …`);
  try {
    const t0 = performance.now();
    const r = await loadCopcNaive(ds.url, POINT_BUDGET);
    const loadMs = performance.now() - t0;

    const t1 = performance.now();
    const pts = new PointPrimitiveCollection();
    for (let i = 0; i < r.positions.length; i++) {
      pts.add({ position: r.positions[i], color: r.colors[i], pixelSize: 2 });
    }
    viewer.scene.primitives.add(pts);
    const buildMs = performance.now() - t1;

    const bs = BoundingSphere.fromPoints(r.positions);
    const c = Cartographic.fromCartesian(bs.center);
    const lon = CesiumMath.toDegrees(c.longitude);
    const lat = CesiumMath.toDegrees(c.latitude);
    viewer.camera.flyToBoundingSphere(bs, { duration: 2 });

    log(
      `${ds.label}  — naive baseline\n` +
        `points: ${r.pointCount.toLocaleString()} / budget ${POINT_BUDGET.toLocaleString()}\n` +
        `center: ${lon.toFixed(4)}°, ${lat.toFixed(4)}°  (h ${c.height.toFixed(0)}m)\n` +
        `CRS: ${r.crsWkt ? r.crsWkt.slice(0, 46) + '…' : '(none)'}\n` +
        `── timings (ms) ──\n` +
        `create        ${r.timings.createMs.toFixed(0)}\n` +
        `hierarchy     ${r.timings.hierarchyMs.toFixed(0)}\n` +
        `fetch+decode  ${r.timings.fetchDecodeMs.toFixed(0)}   ①②\n` +
        `georef(proj4) ${r.timings.georefMs.toFixed(0)}   ③\n` +
        `build prims   ${buildMs.toFixed(0)}   ③\n` +
        `load total    ${loadMs.toFixed(0)}\n` +
        `좌상단 FPS = ④ 렌더`,
    );
  } catch (e) {
    log('ERROR: ' + (e as Error).message);
    console.error(e);
  }
}

// ── 렌더축(④) fps 벽 측정 — 실 GPU에서. 진입: ?bench  또는  ?bench=100000,500000,... ──
// 헤드리스 software GPU론 fps가 무의미하므로 이 모드는 실제 GPU 머신에서 돌린다.
function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}
function measureFps(ms: number): Promise<number> {
  return new Promise((res) => {
    let frames = 0;
    const t0 = performance.now();
    const loop = () => {
      frames++;
      viewer.scene.requestRender();
      const dt = performance.now() - t0;
      if (dt < ms) requestAnimationFrame(loop);
      else res(Math.round(frames / (dt / 1000)));
    };
    requestAnimationFrame(loop);
  });
}
async function runBench(budgets: number[]) {
  const rows: string[] = ['budget\tpoints\tbuildMs\tfps\theapMB'];
  let flew = false;
  for (const b of budgets) {
    log(`bench: loading ${b.toLocaleString()} …`);
    let r;
    try {
      r = await loadCopcNaive(ds.url, b);
    } catch (e) {
      rows.push(`${b}\tLOAD ERROR: ${(e as Error)?.message ?? e}`);
      log('BENCH\n' + rows.join('\n'));
      break;
    }
    viewer.scene.primitives.removeAll();
    const t = performance.now();
    const pts = new PointPrimitiveCollection();
    for (let i = 0; i < r.positions.length; i++) {
      pts.add({ position: r.positions[i], color: r.colors[i], pixelSize: 2 });
    }
    viewer.scene.primitives.add(pts);
    const buildMs = performance.now() - t;
    if (!flew) {
      viewer.camera.flyToBoundingSphere(BoundingSphere.fromPoints(r.positions), { duration: 0 });
      flew = true;
    }
    await sleep(400); // GPU 버퍼 업로드 settle
    const fps = await measureFps(2000);
    const mem = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory;
    const heapMB = mem ? (mem.usedJSHeapSize / 1048576).toFixed(0) : '?';
    rows.push(`${b.toLocaleString()}\t${r.pointCount.toLocaleString()}\t${buildMs.toFixed(0)}\t${fps}\t${heapMB}`);
    // 매 스텝 즉시 갱신 → 고예산에서 프리즈해도 직전 결과는 남는다
    log('BENCH (실 GPU) — 점↑ 시 fps 무릎 = 렌더 벽\n' + rows.join('\n'));
    console.log(rows[rows.length - 1]);
  }
  log('BENCH DONE\n' + rows.join('\n'));
  console.log('BENCH DONE\n' + rows.join('\n'));
}

// ── Phase 2 스파이크: COPC 노드 → 런타임 pnts → Cesium3DTileset (다리 존재 증명) ──
async function runSpike() {
  log('spike: COPC 노드 로드 중 …');
  try {
    const r = await loadCopcNaive(ds.url, 50_000);
    const bs = BoundingSphere.fromPoints(r.positions);
    const rgb = new Uint8Array(r.positions.length * 3);
    for (let i = 0; i < r.colors.length; i++) {
      rgb[i * 3] = Math.round(r.colors[i].red * 255);
      rgb[i * 3 + 1] = Math.round(r.colors[i].green * 255);
      rgb[i * 3 + 2] = Math.round(r.colors[i].blue * 255);
    }
    const pnts = buildPnts(r.positions, bs.center, rgb);
    const pntsUri = 'data:application/octet-stream;base64,' + toBase64(pnts);
    const tilesetJson = {
      asset: { version: '1.0' },
      geometricError: 1e7,
      root: {
        boundingVolume: { sphere: [bs.center.x, bs.center.y, bs.center.z, bs.radius] },
        geometricError: 0,
        refine: 'ADD',
        content: { uri: pntsUri },
      },
    };
    const tilesetUri = 'data:application/json;base64,' + btoa(JSON.stringify(tilesetJson));

    let tileLoaded = 0;
    let tileFailed = 0;
    let failMsg = '';
    const tileset = await Cesium3DTileset.fromUrl(tilesetUri);
    tileset.tileLoad.addEventListener(() => {
      tileLoaded++;
    });
    tileset.tileFailed.addEventListener((e: unknown) => {
      tileFailed++;
      failMsg = (e as { message?: string })?.message ?? String(e);
    });
    tileset.pointCloudShading.attenuation = true;
    viewer.scene.primitives.add(tileset);
    await viewer.zoomTo(tileset);
    await new Promise((res) => setTimeout(res, 2500)); // 타일 content 로드 settle

    const c = Cartographic.fromCartesian(bs.center);
    const result = {
      spike: 'COPC→pnts→Cesium3DTileset (data URI)',
      points: r.pointCount,
      pntsBytes: pnts.byteLength,
      tileLoaded,
      tileFailed,
      failMsg,
      centerLonLat: [
        +CesiumMath.toDegrees(c.longitude).toFixed(5),
        +CesiumMath.toDegrees(c.latitude).toFixed(5),
      ],
      bridge: tileLoaded > 0 && tileFailed === 0 ? 'OK ✅' : 'FAIL ❌',
    };
    (window as unknown as { __spike: unknown }).__spike = result;
    log('SPIKE\n' + JSON.stringify(result, null, 2));
    console.log('SPIKE RESULT ' + JSON.stringify(result));
  } catch (e) {
    const msg = (e as Error)?.message ?? String(e);
    log('SPIKE ERROR: ' + msg);
    console.error(e);
    console.log('SPIKE RESULT ' + JSON.stringify({ bridge: 'FAIL ❌', error: msg }));
  }
}

// ── 스파이크 ②: on-demand 가로채기 — Cesium 타일 요청을 가로채 요청 시점에 pnts 생성 ──
// 자가진단: Cesium이 fetch를 쓰는지 XHR을 쓰는지 동시에 감지 (XHR이면 서비스워커 필요).
async function runSpike2() {
  log('spike2: on-demand 가로채기 …');
  const flags = { fetchHit: false, xhrAttempted: false, generatedAtRequest: false };
  try {
    const r = await loadCopcNaive(ds.url, 50_000);
    const bs = BoundingSphere.fromPoints(r.positions);
    const rgb = new Uint8Array(r.positions.length * 3);
    for (let i = 0; i < r.colors.length; i++) {
      rgb[i * 3] = Math.round(r.colors[i].red * 255);
      rgb[i * 3 + 1] = Math.round(r.colors[i].green * 255);
      rgb[i * 3 + 2] = Math.round(r.colors[i].blue * 255);
    }

    const origFetch = window.fetch.bind(window);
    window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.includes('/__copc/')) {
        flags.fetchHit = true;
        flags.generatedAtRequest = true;
        const pnts = buildPnts(r.positions, bs.center, rgb); // ← 요청 시점에 생성
        return Promise.resolve(
          new Response(pnts, { status: 200, headers: { 'Content-Type': 'application/octet-stream' } }),
        );
      }
      return origFetch(input, init);
    }) as typeof window.fetch;

    const origOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (method: string, url: string | URL, ...rest: unknown[]) {
      if (String(url).includes('/__copc/')) flags.xhrAttempted = true;
      return (origOpen as (...a: unknown[]) => void).call(this, method, url, ...rest);
    };

    const tilesetJson = {
      asset: { version: '1.0' },
      geometricError: 1e7,
      root: {
        boundingVolume: { sphere: [bs.center.x, bs.center.y, bs.center.z, bs.radius] },
        geometricError: 0,
        refine: 'ADD',
        content: { uri: location.origin + '/__copc/root.pnts' }, // 평범한 URL — Cesium이 fetch
      },
    };
    const tilesetUri = 'data:application/json;base64,' + btoa(JSON.stringify(tilesetJson));

    let tileLoaded = 0;
    let tileFailed = 0;
    let failMsg = '';
    const tileset = await Cesium3DTileset.fromUrl(tilesetUri);
    tileset.tileLoad.addEventListener(() => {
      tileLoaded++;
    });
    tileset.tileFailed.addEventListener((e: unknown) => {
      tileFailed++;
      failMsg = (e as { message?: string })?.message ?? String(e);
    });
    viewer.scene.primitives.add(tileset);
    await viewer.zoomTo(tileset);
    await new Promise((res) => setTimeout(res, 2500));

    const mechanism = flags.fetchHit ? 'fetch ✅' : flags.xhrAttempted ? 'XHR(서비스워커 필요)' : '미요청?';
    const result = {
      spike: 'on-demand 가로채기',
      mechanism,
      ...flags,
      tileLoaded,
      tileFailed,
      failMsg,
      onDemand: flags.fetchHit && tileLoaded > 0 ? 'OK ✅' : 'CHECK',
    };
    (window as unknown as { __spike2: unknown }).__spike2 = result;
    log('SPIKE2\n' + JSON.stringify(result, null, 2));
    console.log('SPIKE2 RESULT ' + JSON.stringify(result));
  } catch (e) {
    const msg = (e as Error)?.message ?? String(e);
    log('SPIKE2 ERROR: ' + msg);
    console.error(e);
    console.log('SPIKE2 RESULT ' + JSON.stringify({ onDemand: 'FAIL ❌', error: msg }));
  }
}

// ── 스파이크 ③: 서비스워커 가로채기 — Cesium의 타일 XHR을 SW가 잡아 온디맨드 pnts 응답 ──
async function runSpike3() {
  log('spike3: 서비스워커 가로채기 …');
  try {
    if (!('serviceWorker' in navigator)) throw new Error('서비스워커 미지원');
    await navigator.serviceWorker.register('/copc-sw.js');
    await navigator.serviceWorker.ready;
    if (!navigator.serviceWorker.controller) {
      await new Promise<void>((res) =>
        navigator.serviceWorker.addEventListener('controllerchange', () => res(), { once: true }),
      );
    }
    const center = Cartesian3.fromDegrees(-123.0687, 44.0559, 200);
    const radius = 400;
    const uri = `${location.origin}/__copc/root.pnts?cx=${center.x}&cy=${center.y}&cz=${center.z}`;
    const tilesetJson = {
      asset: { version: '1.0' },
      geometricError: 1e7,
      root: {
        boundingVolume: { sphere: [center.x, center.y, center.z, radius] },
        geometricError: 0,
        refine: 'ADD',
        content: { uri },
      },
    };
    const tilesetUri = 'data:application/json;base64,' + btoa(JSON.stringify(tilesetJson));

    let tileLoaded = 0;
    let tileFailed = 0;
    let failMsg = '';
    const tileset = await Cesium3DTileset.fromUrl(tilesetUri);
    tileset.tileLoad.addEventListener(() => {
      tileLoaded++;
    });
    tileset.tileFailed.addEventListener((e: unknown) => {
      tileFailed++;
      failMsg = (e as { message?: string })?.message ?? String(e);
    });
    viewer.scene.primitives.add(tileset);
    await viewer.zoomTo(tileset);
    await new Promise((res) => setTimeout(res, 2500));

    const controlled = !!navigator.serviceWorker.controller;
    const result = {
      spike: '서비스워커 가로채기',
      swControlled: controlled,
      tileLoaded,
      tileFailed,
      failMsg,
      // 진짜 네트워크엔 이 URL이 없으므로 tileLoad>0 = SW가 XHR을 잡아 응답한 것
      swIntercept: controlled && tileLoaded > 0 ? 'OK ✅ (XHR도 가로챔)' : 'CHECK',
    };
    (window as unknown as { __spike3: unknown }).__spike3 = result;
    log('SPIKE3\n' + JSON.stringify(result, null, 2));
    console.log('SPIKE3 RESULT ' + JSON.stringify(result));
  } catch (e) {
    const msg = (e as Error)?.message ?? String(e);
    log('SPIKE3 ERROR: ' + msg);
    console.error(e);
    console.log('SPIKE3 RESULT ' + JSON.stringify({ swIntercept: 'FAIL ❌', error: msg }));
  }
}

// ── 본편 ①: 진짜 COPC via 서비스워커 (SW가 페이지에 라우팅 → 페이지 copc.js가 디코드) ──
async function runSpike4() {
  log('spike4: 진짜 COPC via 서비스워커 …');
  try {
    if (!('serviceWorker' in navigator)) throw new Error('서비스워커 미지원');
    // 옛 SW(이전 스파이크)가 제어 중이면 stale → 먼저 모두 해제 후 새로 등록 (제어권 강제 교체)
    const regs = await navigator.serviceWorker.getRegistrations();
    await Promise.all(regs.map((rg) => rg.unregister()));
    await navigator.serviceWorker.register('/copc-sw.js');
    await navigator.serviceWorker.ready;
    if (!navigator.serviceWorker.controller) {
      await new Promise<void>((res) =>
        navigator.serviceWorker.addEventListener('controllerchange', () => res(), { once: true }),
      );
    }

    const r = await loadCopcNaive(ds.url, 50_000); // 진짜 Autzen 루트 노드
    const bs = BoundingSphere.fromPoints(r.positions);
    const rgb = new Uint8Array(r.positions.length * 3);
    for (let i = 0; i < r.colors.length; i++) {
      rgb[i * 3] = Math.round(r.colors[i].red * 255);
      rgb[i * 3 + 1] = Math.round(r.colors[i].green * 255);
      rgb[i * 3 + 2] = Math.round(r.colors[i].blue * 255);
    }
    const pnts = buildPnts(r.positions, bs.center, rgb);
    let swAsked = 0;

    navigator.serviceWorker.addEventListener('message', (ev: MessageEvent) => {
      if ((ev.data as { type?: string })?.type === 'copc-tile') {
        swAsked++;
        ev.ports[0]?.postMessage(pnts.slice(0)); // 진짜 pnts 복사본 응답
      }
    });

    const uri = `${location.origin}/__copc-real/root.pnts`;
    const tilesetJson = {
      asset: { version: '1.0' },
      geometricError: 1e7,
      root: {
        boundingVolume: { sphere: [bs.center.x, bs.center.y, bs.center.z, bs.radius] },
        geometricError: 0,
        refine: 'ADD',
        content: { uri },
      },
    };
    const tilesetUri = 'data:application/json;base64,' + btoa(JSON.stringify(tilesetJson));

    let tileLoaded = 0;
    let tileFailed = 0;
    let failMsg = '';
    const tileset = await Cesium3DTileset.fromUrl(tilesetUri);
    tileset.tileLoad.addEventListener(() => {
      tileLoaded++;
    });
    tileset.tileFailed.addEventListener((e: unknown) => {
      tileFailed++;
      failMsg = (e as { message?: string })?.message ?? String(e);
    });
    viewer.scene.primitives.add(tileset);
    await viewer.zoomTo(tileset);
    await new Promise((res) => setTimeout(res, 3000));

    const c = Cartographic.fromCartesian(bs.center);
    const result = {
      spike: '진짜 COPC via 서비스워커 (SW→페이지 라우팅)',
      points: r.pointCount,
      swAsked,
      tileLoaded,
      tileFailed,
      failMsg,
      centerLonLat: [
        +CesiumMath.toDegrees(c.longitude).toFixed(5),
        +CesiumMath.toDegrees(c.latitude).toFixed(5),
      ],
      realCopcStream: swAsked > 0 && tileLoaded > 0 && tileFailed === 0 ? 'OK ✅' : 'CHECK',
    };
    (window as unknown as { __spike4: unknown }).__spike4 = result;
    log('SPIKE4\n' + JSON.stringify(result, null, 2));
    console.log('SPIKE4 RESULT ' + JSON.stringify(result));
  } catch (e) {
    const msg = (e as Error)?.message ?? String(e);
    log('SPIKE4 ERROR: ' + msg);
    console.error(e);
    console.log('SPIKE4 RESULT ' + JSON.stringify({ realCopcStream: 'FAIL ❌', error: msg }));
  }
}

const params = new URLSearchParams(location.search);
if (params.has('bench')) {
  const custom = params.get('bench');
  const budgets =
    custom && custom.includes(',')
      ? custom.split(',').map((s) => Number(s.trim())).filter((n) => n > 0)
      : [100_000, 250_000, 500_000, 1_000_000, 2_000_000, 4_000_000];
  runBench(budgets);
} else if (params.has('spike4')) {
  runSpike4();
} else if (params.has('spike3')) {
  runSpike3();
} else if (params.has('spike2')) {
  runSpike2();
} else if (params.has('spike')) {
  runSpike();
} else {
  run();
}

export { viewer };
