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
  attrReq?: AttributeRequest;
  attrSpecs?: AttributeSpec[]; // 첫 decode 때 view.dimensions 로 확정·캐시
  attrSpecsPromise?: Promise<AttributeSpec[]>; // 동시 첫-decode 가 공유하는 in-flight 프로브(중복 디코드 방지)
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
    const nd = await decodeNode(e.session, key, lazPerf, e.colorBy, e.hideClass, e.attrSpecs);
    // 이슈 #03: 진짜 누락 노드는 throw(버그 표면화→500), 빈 노드(0점·전부 노이즈)는 null(빈 신호→SW 404).
    // 빈 pnts 를 빌드하지 않는다(0점 Model 은 PROCESSING 영구 고착).
    if (!nd) throw new Error(`디코드 노드 없음: ${key}`);
    if (nd.count === 0) return null;
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
