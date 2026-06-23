import * as Comlink from 'comlink';
import { Copc } from 'copc';
import { LazPerf } from 'laz-perf/lib/web';
// laz-perf 의 main 은 node 빌드 → web 빌드 + wasm URL(?url)을 워커 번들 문맥에서 해석해 주입.
import lazPerfWasmUrl from 'laz-perf/lib/web/laz-perf.wasm?url';
import { openCopc, decodeNode, loadSubPage, nearestPoint as coreNearestPoint, type CopcSession, type CoalesceOpts } from './copc-core';
import { buildQuantizedPnts } from './pnts-quantized';
import type { ColorBy } from './colors';
import { resolveAttributes, type AttributeRequest, type AttributeSpec } from './attributes';

// 디코드 워커: laz-perf(WASM) 디코드 + proj4 reproject + pnts 빌드를 메인스레드 밖에서 수행.
// Cesium 을 import 하지 않는다(워커 번들 경량 유지). comlink 로 페이지와 RPC.

let lazPerfPromise: ReturnType<typeof LazPerf.create> | undefined;
function getLazPerf() {
  if (!lazPerfPromise) lazPerfPromise = LazPerf.create({ locateFile: () => lazPerfWasmUrl });
  return lazPerfPromise;
}

type Entry = {
  session: CopcSession;
  colorBy: ColorBy;
  hideClass: Set<number>;
  attrReq?: AttributeRequest;
  attrSpecs?: AttributeSpec[]; // 첫 decode 때 view.dimensions 로 확정·캐시
  attrSpecsPromise?: Promise<AttributeSpec[]>; // 동시 첫-decode 가 공유하는 in-flight 프로브(중복 디코드 방지)
};
const sessions = new Map<string, Entry>(); // sid → 디코드 세션 (다중 tileset)

// 진단(이슈 #02): per-decode 타이밍 수집(경량 performance.now). resource timing 버퍼는 다수 range 요청용 확대.
// 이슈 #04: heapMB(laz-perf WASM heap 현재 크기)·nodePts(raw 노드 점수) 추가 — 2GB abort 궤적 측정용.
const decodeProfile: Array<{ key: string; decodeMs: number; buildMs: number; n: number; heapMB: number; nodePts: number }> = [];
try {
  (performance as { setResourceTimingBufferSize?: (n: number) => void }).setResourceTimingBufferSize?.(2000);
} catch {
  /* noop */
}

const api = {
  /** COPC 를 열어 디코드용 세션을 워커에 보관 (sid 로 키). colorBy 는 색칠 모드, hideClassifications 는 제외할 classification. */
  async open(
    sid: string,
    url: string,
    opts?: { colorBy?: ColorBy; hideClassifications?: number[]; attributes?: AttributeRequest; coalesce?: CoalesceOpts; crs?: string; defaultCrs?: string },
  ): Promise<void> {
    sessions.set(sid, {
      session: await openCopc(url, { coalesce: opts?.coalesce, crs: opts?.crs, defaultCrs: opts?.defaultCrs }),
      colorBy: opts?.colorBy ?? 'height',
      hideClass: new Set(opts?.hideClassifications ?? []),
      attrReq: opts?.attributes,
    });
  },
  /**
   * 노드(key='D-X-Y-Z') 디코드 → 양자화 pnts (zero-copy transfer).
   * 빈 노드(0점 — 전부 노이즈로 필터됨)면 `null`(SW 가 404→Cesium 빈 타일, 이슈 #03).
   * 진짜 누락 노드면 throw(버그 표면화 → 500). 빈 pnts 를 빌드하지 않는다(0점 Model 은 PROCESSING 고착).
   */
  async decode(sid: string, key: string): Promise<ArrayBuffer | null> {
    const e = sessions.get(sid);
    if (!e) throw new Error(`세션 없음: ${sid}`);
    const lazPerf = await getLazPerf();
    // 속성 스펙은 차원 목록이 필요 → 첫 디코드의 view 로 확정·캐시. (속성충실도 — origin/main)
    // 동시 첫-decode 들이 in-flight 프로브 하나를 공유(중복 디코드 방지), 유효 노드일 때만 프로브.
    if (!e.attrSpecs) {
      const node = e.session.nodes[key];
      if (node) {
        if (!e.attrSpecsPromise) {
          e.attrSpecsPromise = (async () => {
            const v = await Copc.loadPointDataView(e.session.getter, e.session.copc, node, { lazPerf });
            return resolveAttributes(Object.keys(v.dimensions), e.attrReq);
          })().catch((err) => {
            e.attrSpecsPromise = undefined; // 실패 시 캐시 비워 다음 decode 가 재시도
            throw err;
          });
        }
        e.attrSpecs = await e.attrSpecsPromise;
      }
    }
    const tDec = performance.now();
    const nd = await decodeNode(e.session, key, lazPerf, e.colorBy, e.hideClass, e.attrSpecs);
    const tDecEnd = performance.now();
    // 이슈 #03: 진짜 누락 노드는 throw(버그 표면화→500), 빈 노드(0점·전부 노이즈)는 null(빈 신호→SW 404).
    // 빈 pnts 를 빌드하지 않는다(0점 Model 은 PROCESSING 영구 고착).
    if (!nd) throw new Error(`디코드 노드 없음: ${key}`);
    if (nd.count === 0) return null;
    const batch = e.attrSpecs && e.attrSpecs.length && nd.attrValues
      ? { specs: e.attrSpecs, values: nd.attrValues }
      : undefined;
    const pnts = buildQuantizedPnts(nd.lonLatH, nd.colors!, batch);
    // 진단(#02): decodeMs=fetch(S3 range)+laz-perf 디코드+reproject, buildMs=pnts 빌드. 배열 상한(누수 방지).
    // #04: heapMB=laz-perf WASM heap 현재 바이트(emscripten 미수축 → 단조 성장 여부 측정), nodePts=raw 노드 점수.
    if (decodeProfile.length < 4096)
      decodeProfile.push({
        key,
        decodeMs: +(tDecEnd - tDec).toFixed(1),
        buildMs: +(performance.now() - tDecEnd).toFixed(1),
        n: nd.count,
        heapMB: +((lazPerf as unknown as { HEAPU8: Uint8Array }).HEAPU8.byteLength / 1e6).toFixed(1),
        nodePts: e.session.nodes[key]?.pointCount ?? 0,
      });
    return Comlink.transfer(pnts, [pnts]);
  },
  /** 서브페이지를 워커 세션에 병합 (페이징 — 후속 그 노드 .pnts 디코드 가능하게). */
  async loadPage(sid: string, key: string): Promise<void> {
    const e = sessions.get(sid);
    if (!e) throw new Error(`세션 없음: ${sid}`);
    await loadSubPage(e.session, key);
  },
  /** 옥트리 풀해상도 최근접점 (이슈 #3-B). WGS84 씨앗 → 가장 깊은 노드 → 최근접 실제 점. */
  async nearestPoint(
    sid: string,
    seed: { lon: number; lat: number; height: number },
  ): Promise<{ lon: number; lat: number; height: number; dist: number; attributes: Record<string, number> } | null> {
    const e = sessions.get(sid);
    if (!e) throw new Error(`세션 없음: ${sid}`);
    const lazPerf = await getLazPerf();
    // 속성 스펙 미해결이면 루트 노드 dimensions 로 해결(decode 와 동일 차원 — 파일 전역 동일).
    if (!e.attrSpecs && e.session.nodes['0-0-0-0']) {
      const v = await Copc.loadPointDataView(e.session.getter, e.session.copc, e.session.nodes['0-0-0-0'], { lazPerf });
      e.attrSpecs = resolveAttributes(Object.keys(v.dimensions), e.attrReq);
    }
    return coreNearestPoint(e.session, seed.lon, seed.lat, seed.height, e.attrSpecs, e.hideClass, lazPerf);
  },
  /** 세션 정리 (tileset.destroy 시). */
  async close(sid: string): Promise<void> {
    sessions.delete(sid);
  },
  /** 진단(이슈 #02): per-decode 타이밍 + 워커가 낸 S3 range fetch resource timing(개수·지속·시작시각). */
  getProfile(): {
    decodes: Array<{ key: string; decodeMs: number; buildMs: number; n: number; heapMB: number; nodePts: number }>;
    resTiming: Array<{ start: number; dur: number; size: number }>;
  } {
    const all = ((performance as { getEntriesByType?: (t: string) => unknown[] }).getEntriesByType?.('resource') ??
      []) as Array<{ name: string; startTime: number; duration: number; transferSize?: number; encodedBodySize?: number }>;
    const resTiming = all
      .filter((e) => /\.copc\.laz/.test(e.name))
      .map((e) => ({ start: +e.startTime.toFixed(1), dur: +e.duration.toFixed(1), size: e.transferSize || e.encodedBodySize || 0 }));
    return { decodes: decodeProfile, resTiming };
  },
};

export type DecodeApi = typeof api;
Comlink.expose(api);
