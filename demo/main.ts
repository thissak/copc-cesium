import {
  Viewer,
  Ion,
  PointPrimitiveCollection,
  BoundingSphere,
  Cartographic,
  Cartesian3,
  Math as CesiumMath,
  HeadingPitchRange,
  Matrix4,
  RequestScheduler,
} from 'cesium';
import 'cesium/Build/Cesium/Widgets/widgets.css';
import { loadCopcNaive } from './copc';
import { DATASETS } from './datasets';
import { CopcTileset } from '../src/copc-tileset';

// 자체 ion 토큰이 있으면 .env 의 VITE_CESIUM_ION_TOKEN 로 주입. 없으면 베이스맵을 끈다
// (Cesium 기본 ion imagery 는 토큰 없으면 401 — 점군은 토큰 불필요).
const ionToken = import.meta.env.VITE_CESIUM_ION_TOKEN;
if (ionToken) Ion.defaultAccessToken = ionToken;

const viewer = new Viewer('app', {
  timeline: false,
  animation: false,
  geocoder: false,
  baseLayerPicker: false,
  baseLayer: ionToken ? undefined : false,
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
    const nodeCount = () =>
      (tileset as unknown as { copcNodeCount?: () => number }).copcNodeCount?.() ?? '?';
    const rows: string[] = [
      `soak ${ds.label}  cacheBytes=${(tileset.cacheBytes / 1048576).toFixed(0)}MB  near=${nearF} far=${farF} maxReq=${maxReq || 'default(18)'}`,
      't(s)\theapMB\tcesiumMB\ttilesReady\tunloads\tnodes',
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
      rows.push(`${t}\t${heapMB()}\t${cesiumMB}\t${stats?.numberOfTilesWithContentReady ?? '?'}\t${unloads}\t${nodeCount()}`);
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
        JSON.stringify({ cycles: cycle, unloads, finalCesiumMB: +(tileset.totalMemoryUsageInBytes / 1048576).toFixed(0), finalNodes: nodeCount() }),
    );
  } catch (e) {
    log('SOAK ERROR: ' + ((e as Error)?.message ?? e));
    console.error(e);
    console.log('SOAK RESULT ' + JSON.stringify({ error: (e as Error)?.message }));
  }
}

// 지구본만(점군 없이) 같은 경로로 frametime 측정 — 30fps 가 우리 코드냐 환경/globe냐 격리(?perf=globe).
async function runGlobePerf() {
  const secs = Number(new URLSearchParams(location.search).get('secs')) || 15;
  log('perf: 지구본만(점 없음) 측정 …');
  const center = Cartesian3.fromDegrees(-123.07, 44.06, 0); // autzen 부근 지표
  const frametimes: number[] = [];
  let collecting = true;
  let last = performance.now();
  const collect = () => {
    const now = performance.now();
    frametimes.push(now - last);
    last = now;
    viewer.scene.requestRender();
    if (collecting) requestAnimationFrame(collect);
  };
  requestAnimationFrame(collect);
  const t0 = performance.now();
  const dur = secs * 1000;
  while (performance.now() - t0 < dur) {
    const u = (performance.now() - t0) / dur;
    const range = 800 + 4000 * (0.5 - 0.5 * Math.cos(u * Math.PI * 6)); // 800m↔4.8km dive
    viewer.camera.lookAt(center, new HeadingPitchRange(u * Math.PI * 2, -0.6, range));
    await sleep(100);
  }
  collecting = false;
  viewer.camera.lookAtTransform(Matrix4.IDENTITY);
  const pct = (arr: number[], p: number) => {
    if (!arr.length) return 0;
    const s = [...arr].sort((a, b) => a - b);
    return +s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))].toFixed(1);
  };
  const result = {
    mode: 'globe-only (점 없음)',
    secs,
    frames: frametimes.length,
    frametimeMs: { p50: pct(frametimes, 50), p95: pct(frametimes, 95), p99: pct(frametimes, 99) },
    hitches_gt50ms: frametimes.filter((d) => d > 50).length,
    note: '지구본+terrain+imagery 만. 이것도 30fps면 환경(vsync/전원/디스플레이) 또는 Cesium globe 비용 — 우리 코드 무관.',
  };
  (window as unknown as { __perf: unknown }).__perf = result;
  log('PERF (globe-only)\n' + JSON.stringify(result, null, 2));
  console.log('PERF RESULT ' + JSON.stringify(result));
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
  if (params.get('perf') === 'globe') return runGlobePerf();
  const ds = DATASETS.find((d) => d.id === params.get('perf')) ?? DATASETS[1];
  const secs = Number(params.get('secs')) || 30;
  const maxReq = Number(params.get('maxReq')) || 0;
  if (maxReq > 0) RequestScheduler.maximumRequestsPerServer = maxReq;
  const cacheMB = Number(params.get('cache')) || 0;
  const edl = params.get('edl') !== '0'; // 기본 on(출하값). edl=0 으로 끄고 풀스크린 후처리 비용 격리
  const atten = params.get('atten') !== '0';
  const res = Number(params.get('res')) || 0; // resolutionScale — Retina 2x fill-rate 격리 (예: res=0.5)
  if (res > 0) viewer.resolutionScale = res;
  log(`perf: ${ds.label} 측정 …`);
  let lto: PerformanceObserver | undefined;
  try {
    const t0 = performance.now();
    const tileset = await CopcTileset.fromUrl(ds.url, { eyeDomeLighting: edl, attenuation: atten });
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
    const loadTimes: number[] = []; // tileLoad 타임스탬프 → 16ms 창 버스트(②, 하드웨어 무관)
    const longTasks: number[] = []; // longtask 지속(ms) → 메인스레드 freeze(①, 하드웨어 무관)
    tileset.tileUnload.addEventListener(() => unloads++);
    tileset.tileLoad.addEventListener(() => {
      loaded++;
      loadTimes.push(performance.now());
      if (!ttfpMs && addedAt) ttfpMs = performance.now() - addedAt;
    });
    const readyCount = () =>
      (tileset as unknown as { statistics?: { numberOfTilesWithContentReady?: number } }).statistics
        ?.numberOfTilesWithContentReady ?? 0;
    const heapMB = () => {
      const m = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory;
      return m ? m.usedJSHeapSize / 1048576 : 0;
    };

    // ① 메인스레드 freeze 계측 — longtask(50ms+ 블로킹). GPU 무관 데이터(JS+동기 버퍼업로드 호출).
    try {
      lto = new PerformanceObserver((l) => {
        for (const e of l.getEntries()) {
          if (addedAt && e.startTime < addedAt) continue;
          longTasks.push(+e.duration.toFixed(0));
        }
      });
      lto.observe({ type: 'longtask' } as PerformanceObserverInit);
    } catch {
      /* longtask API 미지원 환경 → 빈 배열, 다른 신호로 판정 */
    }

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

    // ② 16ms(60fps 한 프레임) 창 안 최대 타일 도착 수 — 한 프레임이 흡수해야 할 버스트(하드웨어 무관).
    const maxTilesPer16ms = (() => {
      const s = [...loadTimes].sort((a, b) => a - b);
      let mx = 0;
      for (let i = 0; i < s.length; i++) {
        let j = i;
        while (j < s.length && s[j] - s[i] <= 16) j++;
        mx = Math.max(mx, j - i);
      }
      return mx;
    })();

    const pct = (arr: number[], p: number) => {
      if (!arr.length) return 0;
      const s = [...arr].sort((a, b) => a - b);
      return +s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))].toFixed(1);
    };
    const result = {
      ds: ds.id,
      secs,
      msse: tileset.maximumScreenSpaceError,
      edl,
      atten,
      resolutionScale: viewer.resolutionScale,
      maxReq: maxReq || 'default(18)',
      cacheMB: +(tileset.cacheBytes / 1048576).toFixed(0),
      frames: frametimes.length,
      frametimeMs: { p50: pct(frametimes, 50), p95: pct(frametimes, 95), p99: pct(frametimes, 99) },
      hitches_gt50ms: frametimes.filter((d) => d > 50).length,
      // ① 메인스레드 freeze (하드웨어 무관 데이터): 사람이 "끊겼다"고 느끼는 멈춤을 ms 로 직접 측정
      longTaskMs: {
        max: longTasks.length ? Math.max(...longTasks) : 0,
        total: +longTasks.reduce((a, b) => a + b, 0).toFixed(0),
        count: longTasks.length,
      },
      // ② 프레임당 타일 버스트 (하드웨어 무관): 한 프레임에 몰리는 업로드 = jank 원인
      maxTilesPer16ms,
      openMs: +openMs.toFixed(0),
      ttfpMs: +ttfpMs.toFixed(0),
      ttdMs: +ttdMs.toFixed(0),
      peakHeapMB: +peakHeap.toFixed(0),
      peakCesiumMB: +peakCesium.toFixed(0),
      tileUnloads: unloads,
      tilesLoaded: loaded,
      avgTilesReady: +(sumReady / Math.max(1, samples)).toFixed(0),
      copcNodes: (tileset as unknown as { copcNodeCount?: () => number }).copcNodeCount?.() ?? null,
      note: 'frametime=rAF간격. Cesium=globe+terrain+imagery 포함→Potree 직접 fps비교 무효. Playwright=swiftshader(fps 무효, hitch/TTD/메모리는 유의)',
    };
    (window as unknown as { __perf: unknown }).__perf = result;
    log('PERF\n' + JSON.stringify(result, null, 2));
    console.log('PERF RESULT ' + JSON.stringify(result));
  } catch (e) {
    log('PERF ERROR: ' + ((e as Error)?.message ?? e));
    console.error(e);
    console.log('PERF RESULT ' + JSON.stringify({ error: (e as Error)?.message }));
  } finally {
    lto?.disconnect();
  }
}

// 기본 페이지 = 공개 API 데모: CopcTileset.fromUrl 로 변환 없이 LOD 스트리밍
async function runDemo() {
  log('CopcTileset.fromUrl 데모 …');
  const maxReq = Number(new URLSearchParams(location.search).get('maxReq')) || 0; // ③ 동시성 throttle (S3 host당 ~6)
  if (maxReq > 0) RequestScheduler.maximumRequestsPerServer = maxReq;
  const coalesceParam = new URLSearchParams(location.search).get('coalesce');
  const coalesceMaxGap = coalesceParam === '0' ? 0 : undefined; // ?coalesce=0 → off (A/B)
  try {
    const t0 = performance.now();
    // ?maxReq 를 per-host throttle(fromUrl maxRequestsPerServer)에 배선 — 콘텐츠 host 동시성 측정용(이슈 #02).
    const tileset = await CopcTileset.fromUrl(ds.url, {
      ...(maxReq > 0 ? { maxRequestsPerServer: maxReq } : {}),
      ...(coalesceMaxGap !== undefined ? { coalesceMaxGap } : {}),
    }); // API 기본값(MSSE 8)
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
} else if (params.has('naive')) {
  run(); // Phase 1 naive baseline (참고용)
} else {
  runDemo(); // 기본 = 공개 API 데모
}

export { viewer };
