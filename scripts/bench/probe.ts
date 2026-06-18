// 모든 함수는 page.evaluate 로 직렬화되어 브라우저에서 실행된다.
// 외부 스코프/임포트를 참조하면 안 된다. window.viewer 만 의존.

export interface StatSample {
  pointsSelected: number;
  pointsLength: number; // Cesium point-cloud tilesets (COPC) use pointsLength, not numberOfPointsSelected
  tilesReady: number;
  tilesTotal: number;
  pending: number;
  processing: number;
  heapMB: number;
}

export function findTilesetIndex(): number {
  const v: any = (window as any).viewer;
  if (!v || !v.scene || !v.scene.primitives) return -1;
  const prims = v.scene.primitives;
  for (let i = 0; i < prims.length; i++) {
    let p: any;
    try {
      p = prims.get(i);
    } catch {
      continue;
    }
    if (p && p.statistics && typeof p.maximumScreenSpaceError === 'number') return i;
  }
  return -1;
}

export function normalizeAndAnchor(arg: { idx: number; msse: number }): {
  radius: number;
  msse: number;
} {
  const v: any = (window as any).viewer;
  if (!v) throw new Error('normalizeAndAnchor: window.viewer missing');
  if (v.scene.globe) v.scene.globe.show = false;
  if (v.imageryLayers && v.imageryLayers.removeAll) v.imageryLayers.removeAll();
  const ts: any = v.scene.primitives.get(arg.idx);
  ts.maximumScreenSpaceError = arg.msse;
  const bs = ts.boundingSphere;
  v.camera.flyToBoundingSphere(bs, { duration: 0 });
  v.scene.requestRender();
  return { radius: bs.radius, msse: ts.maximumScreenSpaceError };
}

export function readStats(idx: number): StatSample {
  const v: any = (window as any).viewer;
  const ts: any = v.scene.primitives.get(idx);
  const st: any = ts.statistics || {};
  const mem: any = (performance as any).memory;
  return {
    pointsSelected: st.numberOfPointsSelected ?? 0,
    pointsLength: st.pointsLength ?? 0, // non-zero for COPC point-cloud tilesets
    tilesReady: st.numberOfTilesWithContentReady ?? 0,
    tilesTotal: st.numberOfTilesTotal ?? 0,
    pending: st.numberOfPendingRequests ?? 0,
    processing: st.numberOfTilesProcessing ?? 0,
    heapMB: mem ? +(mem.usedJSHeapSize / 1048576).toFixed(1) : 0,
  };
}

export function installProbe(): void {
  const w: any = window;
  w.__bench = { frametimes: [], longTasks: [], last: performance.now(), collecting: true };
  const v: any = w.viewer;
  const loop = () => {
    const now = performance.now();
    w.__bench.frametimes.push(now - w.__bench.last);
    w.__bench.last = now;
    if (v && v.scene && v.scene.requestRender) v.scene.requestRender();
    if (w.__bench.collecting) requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
  try {
    const obs = new PerformanceObserver((l) => {
      for (const e of l.getEntries()) w.__bench.longTasks.push(Math.round((e as any).duration));
    });
    obs.observe({ type: 'longtask' } as any);
    w.__bench.obs = obs;
  } catch {
    /* longtask 미지원 → 빈 배열 */
  }
}

// 호출: await page.evaluate(runStress, {idx, secs}). page.evaluate가 반환 Promise를 await하므로 약 secs초 실행된다.
export async function runStress(arg: { idx: number; secs: number }): Promise<void> {
  const v: any = (window as any).viewer;
  const ts: any = v.scene.primitives.get(arg.idx);
  const bs = ts.boundingSphere;
  const cam = v.camera;
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const start = performance.now();
  const dur = arg.secs * 1000;
  while (performance.now() - start < dur) {
    cam.flyToBoundingSphere(bs, { duration: 0 }); // 결정적 재앵커
    cam.zoomIn(bs.radius * 0.7); // 깊은 LOD 다이브
    v.scene.requestRender();
    await sleep(700);
    cam.rotateRight(0.6); // 새 섹터로 팬
    v.scene.requestRender();
    await sleep(500);
    cam.zoomOut(bs.radius * 0.5); // 후퇴 → unload churn
    v.scene.requestRender();
    await sleep(500);
  }
}

export function collectProbe(): { frametimes: number[]; longTasks: number[] } {
  const w: any = window;
  if (!w.__bench) return { frametimes: [], longTasks: [] };
  w.__bench.collecting = false;
  if (w.__bench.obs)
    try {
      w.__bench.obs.disconnect();
    } catch {
      /* noop */
    }
  return { frametimes: w.__bench.frametimes, longTasks: w.__bench.longTasks };
}

export function getGlRenderer(): string {
  try {
    const v: any = (window as any).viewer;
    const c: any = (v && v.canvas) || document.querySelector('canvas');
    const gl: any = c && (c.getContext('webgl2') || c.getContext('webgl'));
    if (!gl) return 'no-webgl';
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    return ext
      ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL))
      : String(gl.getParameter(gl.RENDERER));
  } catch {
    return 'err';
  }
}

// --- issue #03 진단 ---
// allTilesLoaded/initialTilesLoaded 이벤트가 실제로 fire 되는지 관찰(가설 A 검증).
// settle 전에 호출해 리스너를 건다.
export function watchTilesLoaded(idx: number): void {
  const w: any = window;
  const v: any = w.viewer;
  const ts: any = v.scene.primitives.get(idx);
  w.__allTilesLoadedFired = false;
  w.__initialTilesLoadedFired = false;
  if (ts.allTilesLoaded && ts.allTilesLoaded.addEventListener)
    ts.allTilesLoaded.addEventListener(() => {
      w.__allTilesLoadedFired = true;
    });
  if (ts.initialTilesLoaded && ts.initialTilesLoaded.addEventListener)
    ts.initialTilesLoaded.addEventListener(() => {
      w.__initialTilesLoadedFired = true;
    });
}

// 타일트리를 순회해 content state 분포 + PROCESSING 고착 타일의 정체를 덤프한다.
// Cesium3DTileContentState: UNLOADED0 LOADING1 PROCESSING2 READY3 EXPIRED4 FAILED5
export function inspectTiles(idx: number): {
  tilesLoaded: boolean;
  allTilesLoadedFired: boolean;
  initialTilesLoadedFired: boolean;
  processing: number;
  pending: number;
  tilesReady: number;
  byState: Record<string, number>;
  visited: number;
  stuck: Array<{
    depth: number;
    ge: number;
    contentReady: boolean;
    contentFailed: boolean;
    state: number;
    uri: string | null;
    contentType: string | null;
  }>;
} {
  const w: any = window;
  const v: any = w.viewer;
  const ts: any = v.scene.primitives.get(idx);
  const st: any = ts.statistics || {};
  const byState: Record<string, number> = {};
  const stuck: any[] = [];
  const stack: any[] = ts.root ? [ts.root] : [];
  let visited = 0;
  while (stack.length && visited < 200000) {
    const t: any = stack.pop();
    visited++;
    const cs = typeof t._contentState === 'number' ? t._contentState : -1;
    const key = String(cs);
    byState[key] = (byState[key] || 0) + 1;
    // PROCESSING(2) 직접 매치 + "content 있으나 ready/failed 아님" 폴백(enum 리네임 방어)
    const isStuck = cs === 2 || (!!t.content && !t.contentReady && !t.contentFailed);
    if (isStuck) {
      const hdr = t._header || {};
      const c = hdr.content || {};
      const ct: any = t.content || {};
      const model: any = ct._model || null;
      stuck.push({
        depth: typeof t._depth === 'number' ? t._depth : -1,
        ge: typeof t.geometricError === 'number' ? +t.geometricError.toFixed(2) : -1,
        contentReady: !!t.contentReady,
        contentFailed: !!t.contentFailed,
        state: cs,
        uri: c.uri || c.url || null,
        contentType: (t.content && t.content.constructor && t.content.constructor.name) || null,
        pointsLength: typeof ct.pointsLength === 'number' ? ct.pointsLength : -1,
        contentReadyGetter: (() => {
          try {
            return !!ct.ready;
          } catch {
            return null;
          }
        })(),
        modelReady: model ? !!model.ready : null,
      });
    }
    const ch = t.children || [];
    for (let i = 0; i < ch.length; i++) stack.push(ch[i]);
  }
  return {
    tilesLoaded: !!ts.tilesLoaded,
    allTilesLoadedFired: !!w.__allTilesLoadedFired,
    initialTilesLoadedFired: !!w.__initialTilesLoadedFired,
    processing: st.numberOfTilesProcessing ?? -1,
    pending: st.numberOfPendingRequests ?? -1,
    tilesReady: st.numberOfTilesWithContentReady ?? -1,
    byState,
    visited,
    stuck,
  };
}
