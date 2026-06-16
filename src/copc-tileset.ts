import { Cesium3DTileset, Cartesian3, BoundingSphere, Color } from 'cesium';
import { openCopc, decodeNode, type CopcSession } from './copc-core';
import { getLazPerf } from './copc';
import { buildTileset } from './tileset';
import { buildPnts } from './pnts';

// 공개 API: COPC URL → 변환 없이 LOD 스트리밍되는 Cesium3DTileset.
// (TIFFImageryProvider 의 fromUrl 패턴. ADR-001)
//
//   const tileset = await CopcTileset.fromUrl(url);
//   viewer.scene.primitives.add(tileset);
//
// 동작: 옥트리 → 동적 tileset 트리. Cesium SSE 가 노드를 요청하면 서비스워커가 가로채
//       페이지로 라우팅 → 그 노드만 디코드해 pnts 로 응답. (LOD 는 Cesium 위임)

export interface CopcTilesetOptions {
  /** Cesium LOD 노브 (낮을수록 디테일↑·부하↑). 기본 Cesium 기본값. */
  maximumScreenSpaceError?: number;
}

type LazPerf = Awaited<ReturnType<typeof getLazPerf>>;

const sessions = new Map<string, CopcSession>(); // sid → 세션 (다중 tileset 지원)
let handlerInstalled = false;
let lazPerf: LazPerf | undefined;
let sidCounter = 0;

function nodeToPnts(nd: { lonLatH: number[]; zVals: number[] }): ArrayBuffer {
  const positions = Cartesian3.fromDegreesArrayHeights(nd.lonLatH);
  const center = BoundingSphere.fromPoints(positions).center;
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
  return buildPnts(positions, center, rgb);
}

function installHandler() {
  if (handlerInstalled) return;
  handlerInstalled = true;
  navigator.serviceWorker.addEventListener('message', async (ev: MessageEvent) => {
    const d = ev.data as { type?: string; path?: string };
    if (d?.type !== 'copc-tile' || !d.path) return;
    const port = ev.ports[0];
    try {
      const slash = d.path.indexOf('/'); // path = "{sid}/{D-X-Y-Z}.pnts"
      const sid = d.path.slice(0, slash);
      const key = d.path.slice(slash + 1).replace('.pnts', '');
      const session = sessions.get(sid);
      if (!session) return void port?.postMessage({ error: `no session ${sid}` });
      const nd = await decodeNode(session, key, lazPerf);
      if (!nd) return void port?.postMessage({ error: `no node ${key}` });
      const pnts = nodeToPnts(nd);
      port?.postMessage(pnts, [pnts]);
    } catch (err) {
      port?.postMessage({ error: (err as Error)?.message ?? String(err) });
    }
  });
}

async function ensureServiceWorker(): Promise<void> {
  if (!('serviceWorker' in navigator)) throw new Error('Service Worker 미지원 (COPC 스트리밍 필요)');
  const reg = await navigator.serviceWorker.register('/copc-sw.js');
  await reg.update();
  await navigator.serviceWorker.ready;
  if (!navigator.serviceWorker.controller) {
    await new Promise<void>((res) =>
      navigator.serviceWorker.addEventListener('controllerchange', () => res(), { once: true }),
    );
  }
}

export const CopcTileset = {
  /** COPC URL → LOD 스트리밍 Cesium3DTileset. viewer.scene.primitives.add(tileset) 로 사용. */
  async fromUrl(url: string, options: CopcTilesetOptions = {}): Promise<Cesium3DTileset> {
    await ensureServiceWorker();
    installHandler();
    if (!lazPerf) lazPerf = await getLazPerf();

    const session = await openCopc(url);
    const sid = `s${++sidCounter}`;
    sessions.set(sid, session);

    const contentBase = `${location.origin}/__copc-real/${sid}/`;
    const tilesetJson = buildTileset(session, contentBase);
    const tileset = await Cesium3DTileset.fromUrl(
      'data:application/json;base64,' + btoa(JSON.stringify(tilesetJson)),
    );
    if (options.maximumScreenSpaceError != null) {
      tileset.maximumScreenSpaceError = options.maximumScreenSpaceError;
    }
    return tileset;
  },
};
