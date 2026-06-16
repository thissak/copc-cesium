import { Cesium3DTileset, Cesium3DTileStyle } from 'cesium';
import * as Comlink from 'comlink';
import { openCopc } from './copc-core';
import { buildTileset } from './tileset';
import type { DecodeApi, ColorBy } from './decode.worker';

// 공개 API: COPC URL → 변환 없이 LOD 스트리밍되는 Cesium3DTileset.
// (TIFFImageryProvider 의 fromUrl 패턴. ADR-001)
//
//   const tileset = await CopcTileset.fromUrl(url);
//   viewer.scene.primitives.add(tileset);
//
// 동작: 옥트리 → 동적 tileset 트리. Cesium SSE 가 노드를 요청하면 서비스워커가 가로채
//       페이지로 라우팅 → 페이지가 Web Worker 에 위임해 그 노드만 디코드·pnts 로 응답.
//       (디코드는 Worker, LOD 는 Cesium 위임)

export interface CopcTilesetOptions {
  /** Cesium LOD 노브 (낮을수록 디테일↑·부하↑). 기본 8. */
  maximumScreenSpaceError?: number;
  /** 점 픽셀 크기 (Cesium3DTileStyle.pointSize). attenuation off 일 때 적용. */
  pointSize?: number;
  /** 거리 기반 점 크기 감쇠 (pointCloudShading). 거친 LOD 끊김 완화. */
  attenuation?: boolean;
  /** Eye Dome Lighting — 깊이 윤곽 강조(LOD 단차 가림). attenuation 을 동반한다. */
  eyeDomeLighting?: boolean;
  /** 색칠: 'height'(기본, 고도 램프) | 'rgb'(COPC RGB, 없으면 height 폴백). */
  colorBy?: ColorBy;
}

let handlerInstalled = false;
let sidCounter = 0;

let worker: Worker | undefined;
let workerApi: Comlink.Remote<DecodeApi> | undefined;
function getWorkerApi(): Comlink.Remote<DecodeApi> {
  if (!workerApi) {
    worker = new Worker(new URL('./decode.worker.ts', import.meta.url), { type: 'module' });
    workerApi = Comlink.wrap<DecodeApi>(worker);
  }
  return workerApi;
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
      const pnts = await getWorkerApi().decode(sid, key); // 워커에서 디코드(메인스레드 밖)
      if (!pnts) return void port?.postMessage({ error: `no node ${key}` });
      port?.postMessage(pnts, [pnts]); // zero-copy 로 SW 에 전달
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

    const sid = `s${++sidCounter}`;
    // 디코드 세션(laz-perf 포함)은 워커가 보관, 지오메트리(tileset.json)용 세션은 페이지에서.
    // 페이지 openCopc 는 헤더+옥트리만(점 디코드·WASM 불필요) → 경량. 둘은 병렬로 연다.
    const api = getWorkerApi();
    const [session] = await Promise.all([
      openCopc(url),
      api.open(sid, url, { colorBy: options.colorBy ?? 'height' }),
    ]);

    const contentBase = `${location.origin}/__copc-real/${sid}/`;
    const tilesetJson = buildTileset(session, contentBase);
    const tileset = await Cesium3DTileset.fromUrl(
      'data:application/json;base64,' + btoa(JSON.stringify(tilesetJson)),
    );
    tileset.maximumScreenSpaceError = options.maximumScreenSpaceError ?? 8;
    if (options.pointSize !== undefined) {
      tileset.style = new Cesium3DTileStyle({ pointSize: options.pointSize });
    }
    // EDL 은 attenuation 위에서 그려지므로 EDL 켜면 attenuation 도 켠다.
    const edl = options.eyeDomeLighting ?? false;
    const atten = (options.attenuation ?? false) || edl;
    if (atten) {
      tileset.pointCloudShading.attenuation = true;
      tileset.pointCloudShading.eyeDomeLighting = edl;
    }
    return tileset;
  },
};
