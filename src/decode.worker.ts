import * as Comlink from 'comlink';
import { Copc } from 'copc';
import { LazPerf } from 'laz-perf/lib/web';
// laz-perf 의 main 은 node 빌드 → web 빌드 + wasm URL(?url)을 워커 번들 문맥에서 해석해 주입.
import lazPerfWasmUrl from 'laz-perf/lib/web/laz-perf.wasm?url';
import { openCopc, decodeNode, loadSubPage, type CopcSession } from './copc-core';
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
  attrReq: AttributeRequest;
  attrSpecs?: AttributeSpec[]; // 첫 decode 때 view.dimensions 로 확정·캐시
};
const sessions = new Map<string, Entry>(); // sid → 디코드 세션 (다중 tileset)

const api = {
  /** COPC 를 열어 디코드용 세션을 워커에 보관 (sid 로 키). colorBy 는 색칠 모드, hideClassifications 는 제외할 classification. */
  async open(
    sid: string,
    url: string,
    opts?: { colorBy?: ColorBy; hideClassifications?: number[]; attributes?: AttributeRequest },
  ): Promise<void> {
    sessions.set(sid, {
      session: await openCopc(url),
      colorBy: opts?.colorBy ?? 'height',
      hideClass: new Set(opts?.hideClassifications ?? []),
      attrReq: opts?.attributes,
    });
  },
  /** 노드(key='D-X-Y-Z') 디코드 → 양자화 pnts (zero-copy transfer). 없는 노드면 null. */
  async decode(sid: string, key: string): Promise<ArrayBuffer | null> {
    const e = sessions.get(sid);
    if (!e) throw new Error(`세션 없음: ${sid}`);
    const lazPerf = await getLazPerf();
    // 속성 스펙은 차원 목록이 필요 → 첫 디코드의 view 로 확정·캐시
    if (e.attrSpecs === undefined) {
      const node = e.session.nodes[key];
      if (node) {
        const v = await Copc.loadPointDataView(e.session.getter, e.session.copc, node, { lazPerf });
        e.attrSpecs = resolveAttributes(Object.keys(v.dimensions), e.attrReq);
      }
    }
    const nd = await decodeNode(e.session, key, lazPerf, e.colorBy, e.hideClass, e.attrSpecs);
    if (!nd) return null;
    const batch = e.attrSpecs && e.attrSpecs.length && nd.attrValues
      ? { specs: e.attrSpecs, values: nd.attrValues }
      : undefined;
    const pnts = buildQuantizedPnts(nd.lonLatH, nd.colors!, batch);
    return Comlink.transfer(pnts, [pnts]);
  },
  /** 서브페이지를 워커 세션에 병합 (페이징 — 후속 그 노드 .pnts 디코드 가능하게). */
  async loadPage(sid: string, key: string): Promise<void> {
    const e = sessions.get(sid);
    if (!e) throw new Error(`세션 없음: ${sid}`);
    await loadSubPage(e.session, key);
  },
  /** 세션 정리 (tileset.destroy 시). */
  async close(sid: string): Promise<void> {
    sessions.delete(sid);
  },
};

export type DecodeApi = typeof api;
Comlink.expose(api);
