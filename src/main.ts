import {
  Viewer,
  Ion,
  PointPrimitiveCollection,
  BoundingSphere,
  Cartographic,
  Cartesian3,
  Color,
  Math as CesiumMath,
  Cesium3DTileset,
  HeadingPitchRange,
  Matrix4,
  RequestScheduler,
} from 'cesium';
import 'cesium/Build/Cesium/Widgets/widgets.css';
import { loadCopcNaive, getLazPerf } from './copc';
import { openCopc, decodeNode } from './copc-core';
import { buildTileset } from './tileset';
import { DATASETS } from './datasets';
import { buildPnts, toBase64 } from './pnts';
import { CopcTileset } from './copc-tileset';

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
// ?ds=autzen|millsite|sofi 로 데이터셋 선택 (기본 autzen — 소형, 정확성 C1; millsite/sofi = 깊은 옥트리).
const ds = DATASETS.find((d) => d.id === new URLSearchParams(location.search).get('ds')) ?? DATASETS[0];

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

// ── 본편 ②: 옥트리 LOD 스트리밍 — 옥트리 전체를 tileset 트리로, 노드별 온디맨드 디코드 ──
async function runSpike5() {
  log('spike5: 옥트리 LOD 스트리밍 …');
  try {
    if (!('serviceWorker' in navigator)) throw new Error('서비스워커 미지원');
    const regs = await navigator.serviceWorker.getRegistrations();
    await Promise.all(regs.map((rg) => rg.unregister()));
    await navigator.serviceWorker.register('/copc-sw.js');
    await navigator.serviceWorker.ready;
    if (!navigator.serviceWorker.controller) {
      await new Promise<void>((res) =>
        navigator.serviceWorker.addEventListener('controllerchange', () => res(), { once: true }),
      );
    }

    const lazPerf = await getLazPerf();
    const session = await openCopc(ds.url);
    const contentBase = `${location.origin}/__copc-real/`;
    const nodeCount = Object.values(session.nodes).filter(Boolean).length;

    let swAsked = 0;
    let decoded = 0;
    navigator.serviceWorker.addEventListener('message', async (ev: MessageEvent) => {
      const data = ev.data as { type?: string; key?: string };
      if (data?.type !== 'copc-tile') return;
      swAsked++;
      const port = ev.ports[0];
      try {
        const key = (data.key || '').replace('.pnts', '');
        const nd = await decodeNode(session, key, lazPerf);
        if (!nd) {
          port?.postMessage({ error: `node ${key} not found` });
          return;
        }
        const positions = Cartesian3.fromDegreesArrayHeights(nd.lonLatH);
        const bs = BoundingSphere.fromPoints(positions);
        let zmin = Infinity;
        let zmax = -Infinity;
        for (const z of nd.zVals) {
          if (z < zmin) zmin = z;
          if (z > zmax) zmax = z;
        }
        const span = zmax - zmin || 1;
        const rgb = new Uint8Array(positions.length * 3);
        for (let i = 0; i < nd.zVals.length; i++) {
          const c = Color.fromHsl((1 - (nd.zVals[i] - zmin) / span) * 0.66, 1, 0.5);
          rgb[i * 3] = Math.round(c.red * 255);
          rgb[i * 3 + 1] = Math.round(c.green * 255);
          rgb[i * 3 + 2] = Math.round(c.blue * 255);
        }
        const pnts = buildPnts(positions, bs.center, rgb);
        decoded++;
        port?.postMessage(pnts, [pnts]);
      } catch (err) {
        port?.postMessage({ error: (err as Error)?.message ?? String(err) });
      }
    });

    const tilesetUri =
      'data:application/json;base64,' + btoa(JSON.stringify(buildTileset(session, contentBase)));

    let tileLoaded = 0;
    let tileFailed = 0;
    let failMsg = '';
    const tileset = await Cesium3DTileset.fromUrl(tilesetUri);
    tileset.maximumScreenSpaceError = 2; // 공격적 refine → 여러 노드 로드(테스트)
    tileset.tileLoad.addEventListener(() => {
      tileLoaded++;
    });
    tileset.tileFailed.addEventListener((e: unknown) => {
      tileFailed++;
      failMsg = (e as { message?: string })?.message ?? String(e);
    });
    viewer.scene.primitives.add(tileset);
    await viewer.zoomTo(tileset);
    await new Promise((res) => setTimeout(res, 5000));

    const stats = (tileset as unknown as {
      statistics?: { numberOfTilesWithContentReady?: number; pointsLength?: number };
    }).statistics;
    const result = {
      spike: '옥트리 LOD 스트리밍 (tileset 트리 + SW)',
      hierarchyNodes: nodeCount,
      swAsked,
      decoded,
      tileLoaded,
      tileFailed,
      failMsg,
      contentReady: stats?.numberOfTilesWithContentReady,
      pointsRendered: stats?.pointsLength,
      lodStream: tileLoaded > 1 && tileFailed === 0 ? 'OK ✅ (다중 노드)' : 'CHECK',
    };
    (window as unknown as { __spike5: unknown }).__spike5 = result;
    log('SPIKE5\n' + JSON.stringify(result, null, 2));
    console.log('SPIKE5 RESULT ' + JSON.stringify(result));
  } catch (e) {
    const msg = (e as Error)?.message ?? String(e);
    log('SPIKE5 ERROR: ' + msg);
    console.error(e);
    console.log('SPIKE5 RESULT ' + JSON.stringify({ lodStream: 'FAIL ❌', error: msg }));
  }
}

// ── 메모리/항해 soak — step1 가설 검증: Cesium 내장 eviction(cacheBytes)이 우리 SW-pnts 에도 engage 하나? ──
// 가설: cacheBytes 한도로 화면 밖 타일 자동 unload → 메모리 plateau. 무한 climb 이면 우리 쪽 누수.
// fps 는 실 GPU 에서만 유의 — 여기선 Cesium 메모리 회계 + JS heap + tileUnload 가 핵심 신호(헤드리스도 유의).
//   ?soak            millsite 90s, 기본 cacheBytes(512MB) — 실 GPU 소크
//   ?soak=autzen     데이터셋 id 지정
//   &cache=8         cacheBytes·overflow 를 8MB 로 (eviction 강제 — 메커니즘 증명용)
//   &secs=60         지속 시간(초)
async function runSoak() {
  const params = new URLSearchParams(location.search);
  const dsId = params.get('soak');
  const ds = DATASETS.find((d) => d.id === dsId) ?? DATASETS[1]; // 기본 millsite(대형)
  const seconds = Number(params.get('secs')) || 90;
  const cacheMB = Number(params.get('cache')) || 0;
  const nearF = Number(params.get('near')) || 0.08; // 근접 줌 강도(작을수록 깊은 LOD·동시성↑)
  const farF = Number(params.get('far')) || 1.2;
  const maxReq = Number(params.get('maxReq')) || 0; // Cesium RequestScheduler server당 동시 요청 상한(③ throttle)
  if (maxReq > 0) RequestScheduler.maximumRequestsPerServer = maxReq;
  log(`soak: ${ds.label} 항해 중 …`);
  try {
    const tileset = await CopcTileset.fromUrl(ds.url);
    if (cacheMB > 0) {
      tileset.cacheBytes = cacheMB * 1048576;
      tileset.maximumCacheOverflowBytes = cacheMB * 1048576; // overflow 도 좁혀 eviction 가시화
    }
    let unloads = 0;
    tileset.tileUnload.addEventListener(() => {
      unloads++;
    });
    viewer.scene.primitives.add(tileset);
    await viewer.zoomTo(tileset);
    const bs = tileset.boundingSphere;
    const heapMB = () => {
      const m = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory;
      return m ? (m.usedJSHeapSize / 1048576).toFixed(0) : '?';
    };
    const rows: string[] = [
      `soak ${ds.label}  cacheBytes=${(tileset.cacheBytes / 1048576).toFixed(0)}MB  near=${nearF} far=${farF} maxReq=${maxReq || 'default(18)'}`,
      't(s)\theapMB\tcesiumMB\ttilesReady\tunloads',
    ];
    const t0 = performance.now();
    let cycle = 0;
    while ((performance.now() - t0) / 1000 < seconds) {
      // 카메라 오실레이션: 깊게 가까이 ↔ 멀리 (깊은 LOD 강제 + 화면밖 churn → load + unload)
      const range = bs.radius * (cycle % 2 === 0 ? nearF : farF);
      viewer.camera.lookAt(bs.center, new HeadingPitchRange(cycle * 0.6, -0.5, range));
      cycle++;
      await sleep(2500); // 스트리밍 settle
      viewer.scene.requestRender();
      const stats = (tileset as unknown as {
        statistics?: { numberOfTilesWithContentReady?: number };
      }).statistics;
      const cesiumMB = (tileset.totalMemoryUsageInBytes / 1048576).toFixed(0);
      const t = ((performance.now() - t0) / 1000).toFixed(0);
      rows.push(`${t}\t${heapMB()}\t${cesiumMB}\t${stats?.numberOfTilesWithContentReady ?? '?'}\t${unloads}`);
      log('SOAK (메모리 항해)\n' + rows.join('\n'));
      console.log('SOAK ROW ' + rows[rows.length - 1]);
    }
    viewer.camera.lookAtTransform(Matrix4.IDENTITY); // lookAt 참조프레임 잠금 해제
    const verdict =
      unloads > 0
        ? 'eviction engage ✅ (tileUnload 발생 → Cesium 이 우리 pnts 도 evict)'
        : 'unload 0 — 메모리 한도 미도달(데이터/캐시) or 미engage. cache↓ 또는 대형 ds 로 재시도';
    rows.push(`판정: ${verdict}`);
    log('SOAK DONE\n' + rows.join('\n'));
    console.log(
      'SOAK DONE ' +
        JSON.stringify({ cycles: cycle, unloads, finalCesiumMB: +(tileset.totalMemoryUsageInBytes / 1048576).toFixed(0) }),
    );
  } catch (e) {
    log('SOAK ERROR: ' + ((e as Error)?.message ?? e));
    console.error(e);
    console.log('SOAK RESULT ' + JSON.stringify({ error: (e as Error)?.message }));
  }
}

// ── 스트리밍 성능·부드러움 측정 — 결정적 카메라 경로 동안 frametime 분포·hitch·TTFP·TTD·메모리 ──
// 개선 전/후를 같은 경로로 비교하는 게 목적. 공정성: Cesium 은 지구본+terrain+imagery 까지 그리므로
// Potree 와 직접 fps 비교는 무효(우리 시간축·hitch·TTD·메모리가 유효 신호). Playwright fps=swiftshader 무효 —
// 실 fps headline 은 실 GPU. 단 hitch·TTFP·TTD·throughput·메모리는 헤드리스(소프트 렌더)에서도 파이프라인 신호로 유의.
//   ?perf            millsite, 30s 경로
//   ?perf=autzen     데이터셋 id
//   &secs=30 &maxReq=6 &cache=MB
async function runPerf() {
  const params = new URLSearchParams(location.search);
  const ds = DATASETS.find((d) => d.id === params.get('perf')) ?? DATASETS[1];
  const secs = Number(params.get('secs')) || 30;
  const maxReq = Number(params.get('maxReq')) || 0;
  if (maxReq > 0) RequestScheduler.maximumRequestsPerServer = maxReq;
  const cacheMB = Number(params.get('cache')) || 0;
  log(`perf: ${ds.label} 측정 …`);
  try {
    const t0 = performance.now();
    const tileset = await CopcTileset.fromUrl(ds.url);
    const openMs = performance.now() - t0;
    if (cacheMB > 0) {
      tileset.cacheBytes = cacheMB * 1048576;
      tileset.maximumCacheOverflowBytes = cacheMB * 1048576;
    }
    const msse = Number(params.get('msse')) || 0; // 낮을수록 깊은 LOD 강제(스트리밍 부하↑). 미지정=기본 8
    if (msse > 0) tileset.maximumScreenSpaceError = msse;
    let unloads = 0;
    let loaded = 0;
    let addedAt = 0;
    let ttfpMs = 0; // 첫 점 화면 도달 (add → first tileLoad)
    tileset.tileUnload.addEventListener(() => unloads++);
    tileset.tileLoad.addEventListener(() => {
      loaded++;
      if (!ttfpMs && addedAt) ttfpMs = performance.now() - addedAt;
    });
    const readyCount = () =>
      (tileset as unknown as { statistics?: { numberOfTilesWithContentReady?: number } }).statistics
        ?.numberOfTilesWithContentReady ?? 0;
    const heapMB = () => {
      const m = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory;
      return m ? m.usedJSHeapSize / 1048576 : 0;
    };

    addedAt = performance.now();
    viewer.scene.primitives.add(tileset);
    await viewer.zoomTo(tileset);
    const bs = tileset.boundingSphere;

    // frametime 수집기 (rAF 간격) — 경로 도는 동안 백그라운드로 누적
    const frametimes: number[] = [];
    let peakHeap = 0;
    let peakCesium = 0;
    let sumReady = 0;
    let samples = 0;
    let collecting = true;
    let last = performance.now();
    const collect = () => {
      const now = performance.now();
      frametimes.push(now - last);
      last = now;
      viewer.scene.requestRender();
      peakHeap = Math.max(peakHeap, heapMB());
      peakCesium = Math.max(peakCesium, tileset.totalMemoryUsageInBytes / 1048576);
      sumReady += readyCount();
      samples++;
      if (collecting) requestAnimationFrame(collect);
    };
    requestAnimationFrame(collect);

    // 결정적 경로: heading 한 바퀴 + range 가 가까이↔멀리 오실레이션(깊은 LOD load + 화면밖 unload churn).
    const pathStart = performance.now();
    const dur = secs * 1000;
    while (performance.now() - pathStart < dur) {
      const u = (performance.now() - pathStart) / dur; // 0..1
      const heading = u * Math.PI * 2; // 한 바퀴(매 dive 마다 새 섹터 → fresh 깊은 노드 churn)
      // range: 0.5→0.05 near↔far 3주기. 깊이 파고들어 deep LOD 스트리밍을 실제로 압박.
      const range = bs.radius * (0.05 + 0.45 * (0.5 - 0.5 * Math.cos(u * Math.PI * 6)));
      viewer.camera.lookAt(bs.center, new HeadingPitchRange(heading, -0.6, range));
      await sleep(100); // rAF 가 그 사이 frametime 수집
    }
    collecting = false;
    await sleep(50);

    // TTD: 고정 깊은 뷰에서 디테일 채우기 완료까지(tilesReady 증가가 멎을 때까지)
    viewer.camera.lookAt(bs.center, new HeadingPitchRange(0, -0.6, bs.radius * 0.15));
    const ttdStart = performance.now();
    let prevReady = -1;
    let stableMs = 0;
    while (performance.now() - ttdStart < 10000) {
      viewer.scene.requestRender();
      await sleep(200);
      const r = readyCount();
      if (r === prevReady && r > 0) {
        stableMs += 200;
        if (stableMs >= 1200) break; // 1.2s 안정 → 채우기 완료로 간주
      } else {
        stableMs = 0;
        prevReady = r;
      }
    }
    const ttdMs = performance.now() - ttdStart - stableMs;
    viewer.camera.lookAtTransform(Matrix4.IDENTITY);

    const pct = (arr: number[], p: number) => {
      if (!arr.length) return 0;
      const s = [...arr].sort((a, b) => a - b);
      return +s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))].toFixed(1);
    };
    const result = {
      ds: ds.id,
      secs,
      msse: tileset.maximumScreenSpaceError,
      maxReq: maxReq || 'default(18)',
      cacheMB: +(tileset.cacheBytes / 1048576).toFixed(0),
      frames: frametimes.length,
      frametimeMs: { p50: pct(frametimes, 50), p95: pct(frametimes, 95), p99: pct(frametimes, 99) },
      hitches_gt50ms: frametimes.filter((d) => d > 50).length,
      openMs: +openMs.toFixed(0),
      ttfpMs: +ttfpMs.toFixed(0),
      ttdMs: +ttdMs.toFixed(0),
      peakHeapMB: +peakHeap.toFixed(0),
      peakCesiumMB: +peakCesium.toFixed(0),
      tileUnloads: unloads,
      tilesLoaded: loaded,
      avgTilesReady: +(sumReady / Math.max(1, samples)).toFixed(0),
      note: 'frametime=rAF간격. Cesium=globe+terrain+imagery 포함→Potree 직접 fps비교 무효. Playwright=swiftshader(fps 무효, hitch/TTD/메모리는 유의)',
    };
    (window as unknown as { __perf: unknown }).__perf = result;
    log('PERF\n' + JSON.stringify(result, null, 2));
    console.log('PERF RESULT ' + JSON.stringify(result));
  } catch (e) {
    log('PERF ERROR: ' + ((e as Error)?.message ?? e));
    console.error(e);
    console.log('PERF RESULT ' + JSON.stringify({ error: (e as Error)?.message }));
  }
}

// 기본 페이지 = 공개 API 데모: CopcTileset.fromUrl 로 변환 없이 LOD 스트리밍
async function runDemo() {
  log('CopcTileset.fromUrl 데모 …');
  const maxReq = Number(new URLSearchParams(location.search).get('maxReq')) || 0; // ③ 동시성 throttle (S3 host당 ~6)
  if (maxReq > 0) RequestScheduler.maximumRequestsPerServer = maxReq;
  try {
    const t0 = performance.now();
    const tileset = await CopcTileset.fromUrl(ds.url); // API 기본값(MSSE 8, 듬성/작은 점 — 진단용)
    let tileLoaded = 0;
    let tileFailed = 0;
    tileset.tileLoad.addEventListener(() => {
      tileLoaded++;
    });
    tileset.tileFailed.addEventListener(() => {
      tileFailed++;
    });
    viewer.scene.primitives.add(tileset);
    await viewer.zoomTo(tileset);
    await new Promise((res) => setTimeout(res, 4000));
    log(
      `${ds.label} — CopcTileset.fromUrl()\n` +
        `변환 없이 원본 COPC 직접 · LOD 스트리밍\n` +
        `로드된 노드: ${tileLoaded} (실패 ${tileFailed})\n` +
        `로드 ${(performance.now() - t0).toFixed(0)}ms · 줌하면 디테일이 채워집니다`,
    );
    console.log('DEMO RESULT ' + JSON.stringify({ tileLoaded, tileFailed }));
  } catch (e) {
    log('DEMO ERROR: ' + ((e as Error)?.message ?? e));
    console.error(e);
    console.log('DEMO RESULT ' + JSON.stringify({ error: (e as Error)?.message }));
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
} else if (params.has('soak')) {
  runSoak();
} else if (params.has('perf')) {
  runPerf();
} else if (params.has('spike5')) {
  runSpike5();
} else if (params.has('spike4')) {
  runSpike4();
} else if (params.has('spike3')) {
  runSpike3();
} else if (params.has('spike2')) {
  runSpike2();
} else if (params.has('spike')) {
  runSpike();
} else if (params.has('naive')) {
  run(); // Phase 1 naive baseline (참고용)
} else {
  runDemo(); // 기본 = 공개 API 데모
}

export { viewer };
