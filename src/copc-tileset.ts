import { Cesium3DTileset, Cesium3DTileStyle, RequestScheduler } from 'cesium';
import type { Scene, Cartesian2 } from 'cesium';
import * as Comlink from 'comlink';
import { Copc } from 'copc';
import { openCopc, loadSubPage, type CopcSession, type CoalesceOpts } from './copc-core';
import { buildTileset, buildSubtree } from './tileset';
import type { DecodeApi } from './decode.worker';
import type { ColorBy } from './colors';
import type { AttributeRequest } from './attributes';
import { snapPoint, type SnappedPoint } from './picking';

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
  /**
   * 깊은 줌 point budget — 렌더 점 개수 상한의 *근사*. 기본 200만(`0` 이하면 끔 = Cesium 기본 512MB).
   * Cesium 은 점-개수 직접 캡이 없어 메모리 예산으로 근사한다: `cacheBytes = maximumCacheOverflowBytes
   * = pointBudget × 8B`(점당 실측 ~16B = 양자화 pnts 위치6+RGB3 + Cesium 오버헤드). 한도 초과 시 Cesium 이
   * `memoryAdjustedScreenSpaceError` 로 refine 을 자동 억제 — **soft limit**(정확한 개수 보장 X; 속성
   * 노출 시 점당 바이트가 늘어 실제 점수는 더 낮아진다). 깊은 줌서 무제한 SSE refine 이 GPU-bound 되던 것을
   * 유계화(측정: sofi 깊은 줌 8M점·8fps → ~1.9M점·~100fps, 이슈 #08). 정상/원거리 뷰는 점이 적어
   * 한도 미달 → 무영향. 더 정밀히 제어하려면 반환된 tileset 의 `cacheBytes` 를 직접 설정.
   */
  pointBudget?: number;
  /** 점 픽셀 크기 (Cesium3DTileStyle.pointSize). attenuation off 일 때 적용. */
  pointSize?: number;
  /** 거리 기반 점 크기 감쇠 (pointCloudShading). 거친 LOD 끊김 완화. 기본 on. */
  attenuation?: boolean;
  /** Eye Dome Lighting — 깊이 윤곽 강조(LOD 단차 가림). attenuation 을 동반한다. 기본 on. */
  eyeDomeLighting?: boolean;
  /** 색칠: 'rgb'(기본, 해당 차원 없으면 height 폴백) | 'height' | 'classification' | 'intensity' | 'returns'. */
  colorBy?: ColorBy;
  /**
   * 디코드 시 제외할 classification(점이 렌더·메모리·카운트에서 빠짐).
   * 기본 ASPRS 노이즈 [7(low), 18(high)] — 측량 표준(PDAL·Potree·LAStools)대로 노이즈 제거.
   * `[]` 를 주면 전부 표시(원본 그대로).
   */
  hideClassifications?: number[];
  /**
   * Cesium 에 노출할 per-point 속성(동적 스타일링·피킹용 batch table).
   * `undefined`=큐레이션 기본(Classification·Intensity·ReturnNumber·NumberOfReturns),
   * `'all'`=extra-bytes 포함 전체, `string[]`=명시(없는 차원은 skip+warn). 노출하면 BATCH_ID 추가(+2~4B/점).
   */
  attributes?: AttributeRequest;
  /**
   * 콘텐츠 호스트(앱 origin)당 Cesium 동시 요청 상한. 기본 `6`.
   * Cesium 의 호스트당 기본값은 18(HTTP/2 가정) — S3 등 HTTP/1.1 range 소스엔 과해
   * 8s 타임아웃·재시도 폭풍을 부른다(측정). 콘텐츠(`/__copc-real/`)는 앱 origin 에서
   * 서빙되므로 그 호스트에만 `RequestScheduler.requestsByServer` 로 상한을 둬, 동시
   * 노드 디코드 → 다운스트림 range fetch 동시성을 게이트한다(전역 설정 미오염).
   * 기본 6 = 브라우저 HTTP/1.1 호스트당 연결 한도·iTowns 출하값·Cesium 1.113 이전 기본값.
   * HTTP/2 CDN(CloudFront 등) 뒤라면 더 높여도 된다. `0` 이하면 설정하지 않는다(Cesium 기본 유지).
   */
  maxRequestsPerServer?: number;
  /** range coalescing: 인접 노드 point-data 를 연속 range 로 병합(이슈 #02). gap 상한(바이트). 기본 256KB. `0` 이하면 off. */
  coalesceMaxGap?: number;
  /** coalescing run 당 최대 병합 크기(바이트). 기본 8MB. */
  coalesceMaxBytes?: number;
  /** coalescing region 캐시 총바이트 상한. 기본 64MB. */
  coalesceCacheBytes?: number;
  /**
   * COPC 콘텐츠를 가로채는 서비스워커 URL. 기본 `/copc-sw.js`.
   * SW 는 콘텐츠 요청(`/__copc-real/...`)을 덮는 scope 에 서빙돼야 한다(기본 root).
   * 소비자는 패키지의 `copc-sw.js` 를 자기 origin 에 복사해 서빙한다. (README)
   */
  serviceWorkerUrl?: string;
  /**
   * 서비스워커 scope. 기본 `/`.
   * 현재 페이지를 제어할 수 있는 scope 여야 Cesium 의 `/__copc-real/...` 요청을 가로챌 수 있다.
   */
  serviceWorkerScope?: string;
  /**
   * CRS override (force) — 파일 헤더 WKT 를 무시하고 이 CRS 로 배치.
   * proj4 string / WKT / 내장 EPSG(WGS84·UTM·WebMercator). 헤더에 CRS 가 없거나 틀릴 때.
   */
  crs?: string;
  /**
   * 헤더에 CRS(WKT)가 없을 때만 적용하는 폴백 CRS(fill-if-missing). `crs`(force)와 구분.
   */
  defaultCrs?: string;
}

/**
 * `CopcTileset.fromUrl()`이 반환하는 Cesium tileset.
 * Cesium 기본 인터페이스에 COPC 세션을 필요로 하는 공개 헬퍼를 더한다.
 */
export type CopcCesiumTileset = Cesium3DTileset & {
  snapPoint(scene: Scene, windowPosition: Cartesian2): Promise<SnappedPoint | undefined>;
  attributeRange(name: string): Promise<[number, number]>;
};

let sidCounter = 0;
const activeSids = new Set<string>(); // 살아있는 tileset 세션 (생명주기 추적)
// 진단(이슈 #20): 디코드 요청 누적/완료 카운터. in-flight = started − done.
// Cesium 이 취소한 타일도 SW→page→worker 가 끝까지 도므로, churn 시 in-flight 가 유계인지 무계 누적인지 측정.
const decodeStats = { started: 0, done: 0 };
const pageSessions = new Map<string, CopcSession>(); // sid → 페이지 지오메트리 세션 (서브페이지 lazy 로드)
const CONTENT_BASE_PATH = '/__copc-real/';

let worker: Worker | undefined;
let workerApi: Comlink.Remote<DecodeApi> | undefined;
function getWorkerApi(): Comlink.Remote<DecodeApi> {
  if (!workerApi) {
    worker = new Worker(new URL('./decode.worker.ts', import.meta.url), { type: 'module' });
    workerApi = Comlink.wrap<DecodeApi>(worker);
  }
  return workerApi;
}

// 디코드 라우팅 한 곳 — 워커 풀은 여기에만 얹으면 된다 (Codex #3).
function decodeTile(sid: string, key: string): Promise<ArrayBuffer | null> {
  return getWorkerApi().decode(sid, key);
}

// 서브페이지 온디맨드: 페이지(지오메트리)·워커(디코드) 세션 둘 다에 서브페이지를 로드한 뒤
// 그 서브트리의 child tileset.json 을 반환. (페이징 — 깊은 옥트리 lazy 확장)
async function buildPageTileset(sid: string, key: string): Promise<string> {
  const session = pageSessions.get(sid);
  if (!session) throw new Error(`세션 없음: ${sid}`);
  const [loaded] = await Promise.all([loadSubPage(session, key), getWorkerApi().loadPage(sid, key)]);
  // 로드도 안 됐고 이미 노드도 없으면 잘못된/만료된 page 키 → 지연된 .pnts 500 대신 즉시 표면화
  if (!loaded && !session.nodes[key]) throw new Error(`page ${key}: 로드 후에도 노드 없음 (잘못된 키)`);
  const contentBase = `${location.origin}${CONTENT_BASE_PATH}${sid}/`;
  return JSON.stringify(buildSubtree(session, key, contentBase));
}

let messageHandler: ((ev: MessageEvent) => void) | undefined;
function installHandler() {
  if (messageHandler) return;
  messageHandler = async (ev: MessageEvent) => {
    const d = ev.data as { type?: string; path?: string };
    if (d?.type !== 'copc-tile' || !d.path) return;
    const port = ev.ports[0];
    try {
      const slash = d.path.indexOf('/'); // "{sid}/{key}.pnts" 또는 "{sid}/page/{key}.json"
      const sid = d.path.slice(0, slash);
      const rest = d.path.slice(slash + 1);
      if (rest.startsWith('page/')) {
        const key = rest.slice('page/'.length).replace('.json', '');
        port?.postMessage({ json: await buildPageTileset(sid, key) }); // 서브페이지 → child tileset
      } else {
        const key = rest.replace('.pnts', '');
        decodeStats.started++; // 진단(#20): 요청 시점 (취소돼도 여기까진 도달)
        try {
          const pnts = await decodeTile(sid, key); // 워커에서 디코드(메인스레드 밖)
          // null = 빈 노드(0점·전부 노이즈) → SW 가 404 → Cesium missingTilePolicy 로 빈 타일(이슈 #03).
          // 진짜 누락 노드는 worker 가 throw → 아래 catch → {error} → 500.
          if (!pnts) return void port?.postMessage({ empty: true });
          port?.postMessage(pnts, [pnts]); // zero-copy 로 SW 에 전달
        } finally {
          decodeStats.done++; // 진단(#20): 완료(성공/빈/예외 무관) — in-flight 감소
        }
      }
    } catch (err) {
      port?.postMessage({ error: (err as Error)?.message ?? String(err) });
    }
  };
  navigator.serviceWorker.addEventListener('message', messageHandler);
}

// 마지막 세션이 사라지면 SW 리스너 제거 + 워커 종료 (전역 상태 누수 차단).
function cleanupIfIdle() {
  if (activeSids.size > 0) return;
  if (messageHandler) {
    navigator.serviceWorker.removeEventListener('message', messageHandler);
    messageHandler = undefined;
  }
  if (worker) {
    worker.terminate();
    worker = undefined;
    workerApi = undefined;
  }
}

// 한 세션(sid) 정리 — destroy 와 fromUrl 초기화 실패 양쪽에서 공유(누수 방지).
function releaseSession(sid: string) {
  if (!activeSids.delete(sid)) return;
  releaseContentServerThrottle(sid);
  pageSessions.delete(sid);
  if (activeSids.size > 0) {
    // fire-and-forget 이지만 rejection 을 삼키지 않는다(조용한 실패 방지)
    workerApi?.close(sid).catch((e) => console.warn(`[copc] worker close 실패 (${sid}):`, e));
  } else cleanupIfIdle();
}

function waitForController(timeoutMs: number): Promise<void> {
  if (navigator.serviceWorker.controller) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      navigator.serviceWorker.removeEventListener('controllerchange', onControllerChange);
      reject(new Error(`Service Worker controllerchange timeout (${timeoutMs}ms)`));
    }, timeoutMs);
    const onControllerChange = () => {
      window.clearTimeout(timeout);
      resolve();
    };
    navigator.serviceWorker.addEventListener('controllerchange', onControllerChange, { once: true });
  });
}

async function ensureServiceWorker(swUrl: string, scope: string): Promise<void> {
  if (!('serviceWorker' in navigator)) throw new Error('Service Worker 미지원 (COPC 스트리밍 필요)');
  const reg = await navigator.serviceWorker.register(swUrl, { scope });
  // freshness check 는 비차단 — register 가 이미 변경 시 update 를 트리거하고, 활성/제어 게이트는
  // 아래 ready / waitForController 가 담당한다. timeout 없는 await 로 fromUrl 을 막지 않는다.
  void reg.update().catch(() => {});
  await navigator.serviceWorker.ready;
  const pageUrl = location.href;
  if (!pageUrl.startsWith(reg.scope)) {
    throw new Error(
      `Service Worker scope가 현재 페이지를 덮지 않습니다. scope=${reg.scope}, page=${pageUrl}. ` +
        'copc-sw.js를 현재 앱 경로를 제어할 수 있는 scope(기본 root)에 서빙하세요.',
    );
  }
  const contentUrl = new URL(CONTENT_BASE_PATH, location.origin).href;
  if (!contentUrl.startsWith(reg.scope)) {
    throw new Error(
      `Service Worker scope가 COPC content 경로를 덮지 않습니다. scope=${reg.scope}, content=${contentUrl}. ` +
        `기본 ${CONTENT_BASE_PATH} 경로를 쓰려면 copc-sw.js를 root scope('/')로 서빙하세요.`,
    );
  }
  try {
    await waitForController(8000);
  } catch (err) {
    throw new Error(
      `Service Worker가 현재 페이지를 제어하지 못했습니다: ${(err as Error).message}. ` +
        `url=${swUrl}, scope=${scope}. copc-sw.js의 scope가 현재 페이지를 덮는지 확인하세요.`,
    );
  }
}

// 콘텐츠(/__copc-real/)는 앱 origin 에서 서빙된다. Cesium RequestScheduler 의 "호스트당 동시 요청"
// 상한을 그 호스트에만 적용해(전역 maximumRequestsPerServer 미오염) 과동시성 range 폭풍을 막는다.
// 서버키는 Cesium getServerKey 와 동일 형식(authority; 기본 포트면 :443/:80 부착) — 타입 미노출이라 직접 구성.
type ThrottleOwner = { serverKey: string; maxPerServer: number };
type ThrottleOriginal = { hadValue: boolean; value: number | undefined };
const throttleOwners = new Map<string, ThrottleOwner>();
const throttleOriginals = new Map<string, ThrottleOriginal>();

function contentServerKey(): string {
  const host = location.host; // hostname[:port]
  return /:/.test(host) ? host : `${host}:${location.protocol === 'https:' ? '443' : '80'}`;
}

function applyContentServerThrottle(serverKey: string): void {
  const limits = [...throttleOwners.values()]
    .filter((owner) => owner.serverKey === serverKey)
    .map((owner) => owner.maxPerServer);
  if (limits.length) {
    RequestScheduler.requestsByServer[serverKey] = Math.min(...limits);
    return;
  }
  const original = throttleOriginals.get(serverKey);
  if (!original) return;
  if (original.hadValue) RequestScheduler.requestsByServer[serverKey] = original.value!;
  else delete RequestScheduler.requestsByServer[serverKey];
  throttleOriginals.delete(serverKey);
}

/** 세션별 호스트 제한 소유권. 다중 세션은 가장 보수적인 양수 상한을 공유한다. */
export function acquireContentServerThrottle(sid: string, maxPerServer: number): void {
  releaseContentServerThrottle(sid);
  if (maxPerServer <= 0) return;
  const serverKey = contentServerKey();
  if (!throttleOriginals.has(serverKey)) {
    throttleOriginals.set(serverKey, {
      hadValue: Object.prototype.hasOwnProperty.call(RequestScheduler.requestsByServer, serverKey),
      value: RequestScheduler.requestsByServer[serverKey],
    });
  }
  throttleOwners.set(sid, { serverKey, maxPerServer });
  applyContentServerThrottle(serverKey);
}

export function releaseContentServerThrottle(sid: string): void {
  const owner = throttleOwners.get(sid);
  if (!owner) return;
  throttleOwners.delete(sid);
  applyContentServerThrottle(owner.serverKey);
}

/** 단일 호출 호환/검증용. 0은 이 호출이 보유한 제한을 해제한다. */
export function setContentServerThrottle(maxPerServer: number): void {
  acquireContentServerThrottle('__direct__', maxPerServer);
}

export const CopcTileset = {
  /** COPC URL → LOD 스트리밍 Cesium3DTileset. viewer.scene.primitives.add(tileset) 로 사용. */
  async fromUrl(url: string, options: CopcTilesetOptions = {}): Promise<CopcCesiumTileset> {
    await ensureServiceWorker(options.serviceWorkerUrl ?? '/copc-sw.js', options.serviceWorkerScope ?? '/');
    installHandler();
    const sid = `s${++sidCounter}`;
    activeSids.add(sid);
    acquireContentServerThrottle(sid, options.maxRequestsPerServer ?? 6);
    try {
      // 디코드 세션(laz-perf 포함)은 워커가 보관, 지오메트리(tileset.json)용 세션은 페이지에서.
      // 페이지 openCopc 는 헤더+옥트리만(점 디코드·WASM 불필요) → 경량. 둘은 병렬로 연다.
      const api = getWorkerApi();
      const gap = options.coalesceMaxGap ?? 256 * 1024;
      const coalesce: CoalesceOpts | undefined =
        gap > 0
          ? {
              maxGap: gap,
              maxBytes: options.coalesceMaxBytes ?? 8 * 1024 * 1024,
              cacheBytes: options.coalesceCacheBytes ?? 64 * 1024 * 1024,
            }
          : undefined;
      const [session] = await Promise.all([
        openCopc(url, { crs: options.crs, defaultCrs: options.defaultCrs }),
        api.open(sid, url, {
          colorBy: options.colorBy ?? 'rgb',
          // --8<-- [start:hideClass]
          hideClassifications: options.hideClassifications ?? [7, 18],
          // --8<-- [end:hideClass]
          attributes: options.attributes,
          coalesce,
          crs: options.crs,
          defaultCrs: options.defaultCrs,
        }),
      ]);
      pageSessions.set(sid, session); // 서브페이지 lazy 로드용으로 보관

      const contentBase = `${location.origin}${CONTENT_BASE_PATH}${sid}/`;
      const tilesetJson = buildTileset(session, contentBase);
      const tileset = (await Cesium3DTileset.fromUrl(
        'data:application/json;base64,' + btoa(JSON.stringify(tilesetJson)),
      )) as CopcCesiumTileset;
      // 빈 노드(전부 노이즈 → 0점)는 SW 가 404 로 응답한다. Cesium 의 missingTilePolicy(빈 타일 정책)로
      // 404 를 Empty3DTileContent(ready·에러 없음)로 처리 → 0점 pnts 가 Model 로 PROCESSING 에 영구
      // 고착하던 결함(tilesLoaded/allTilesLoaded 가 영영 안 잡힘)을 막는다(이슈 #03). createContent 를
      // 주지 않으므로 일반 pnts(200) 경로는 무영향. Cesium 내부(private) 메커니즘 — 버전 결합은 repro-03.ts 가 가드.
      (tileset as unknown as { _runtimeContentCodec?: unknown })._runtimeContentCodec = {
        missingTilePolicy: { statusCodes: [404] },
      };
      // --8<-- [start:maxSSE]
      tileset.maximumScreenSpaceError = options.maximumScreenSpaceError ?? 8;
      // --8<-- [end:maxSSE]
      // 이슈 #08: 깊은 줌 point budget — Cesium 은 점-개수 직접 캡이 없어 메모리예산(cacheBytes)으로 근사.
      // 무제한 SSE refine 이 깊은 줌서 GPU-bound 되던 것을 유계화(measure-first 게이트 통과, docs/issues/08-point-budget.md).
      const pointBudget = options.pointBudget ?? 2_000_000;
      if (pointBudget > 0) {
        const halfBytes = pointBudget * 8; // 실효 한도 = cacheBytes + overflow = pointBudget × 16B(점당 실측 ~16B)
        tileset.cacheBytes = halfBytes;
        tileset.maximumCacheOverflowBytes = halfBytes;
      }
      if (options.pointSize !== undefined) {
        tileset.style = new Cesium3DTileStyle({ pointSize: options.pointSize });
      }
      // EDL 은 attenuation 위에서 그려지므로 EDL 켜면 attenuation 도 켠다.
      const edl = options.eyeDomeLighting ?? true;
      const atten = (options.attenuation ?? true) || edl;
      if (atten) {
        tileset.pointCloudShading.attenuation = true;
        tileset.pointCloudShading.eyeDomeLighting = edl;
      }

      // 생명주기: tileset.destroy() 시 워커 세션 정리. 마지막 세션이면 워커 종료 + SW 리스너 제거.
      // (wrapper 없이 Cesium 인스턴스의 destroy 만 확장 — ADR-001 의 copc.destroy() 그대로 동작)
      const tilesetDestroy = tileset.destroy.bind(tileset);
      (tileset as unknown as { destroy: () => void }).destroy = () => {
        releaseSession(sid);
        tilesetDestroy();
      };

      // 진단: 누적된 옥트리 노드 메타 수. 서브페이지 lazy 로드(loadSubPage)로 단조 증가하며
      // 상한(LRU)이 없다 → 장시간/광역 항해 시 메모리 갭 측정용. 페이지·워커 세션이 같은 키를
      // lockstep 로드하므로 페이지 측 카운트가 양쪽 heap 의 프록시(워커 heap 은 performance.memory 밖).
      (tileset as unknown as { copcNodeCount: () => number }).copcNodeCount = () =>
        Object.keys(pageSessions.get(sid)?.nodes ?? {}).length;

      // 진단(이슈 #02): 워커 디코드 프로파일(per-decode 타이밍 + S3 range fetch resource timing).
      (tileset as unknown as { copcProfile: () => Promise<unknown> }).copcProfile = () =>
        getWorkerApi().getProfile();

      // 옥트리 풀해상도 최근접점 스냅 (이슈 #3-B). pickPosition 씨앗 → 워커 nearestPoint → SnappedPoint.
      tileset.snapPoint =
        (scene, win) =>
          snapPoint(tileset, scene, win, (seed) => {
            // destroy 가 마지막 세션 워커를 terminate 하면 comlink RPC 가 영영 미해소(hang) → 백스톱 타임아웃(무한 대기
            // 금지, PR#21 dual-review). warn 으로 표면화([[no-silent-failures]]) + null resolve 로 snapPoint 의
            // "실패→undefined" 계약 유지(reject 면 소비자 미처리 rejection). 워커 재시도 예산(≈34s)보다 길게 → SW 와 동일 40s.
            let t: ReturnType<typeof setTimeout> | undefined;
            return Promise.race([
              getWorkerApi().nearestPoint(sid, seed),
              new Promise<null>((resolve) => {
                t = setTimeout(() => {
                  console.warn('[copc] snapPoint worker 응답 타임아웃 (40s) — 세션이 snap 중 destroy 됐을 수 있음');
                  resolve(null);
                }, 40000);
              }),
            ])
              .catch((e) => {
                // 워커 throw(예: 비-마지막 tileset destroy 후 '세션 없음')·디코드 오류 → 계약상 undefined 유지
                // (reject 전파 시 소비자 미처리 rejection). warn 으로 표면화(PR#21 R2, [[no-silent-failures]]).
                console.warn('[copc] snapPoint query 실패 →', (e as Error)?.message ?? e);
                return null;
              })
              .finally(() => { if (t) clearTimeout(t); });
          });

      // 진단(이슈 #20): 디코드 요청/완료 누적 + in-flight. churn 시 in-flight 누적 유계성 측정용(취소 미전파 영향).
      (tileset as unknown as { copcDecodeStats: () => { started: number; done: number; inflight: number } }).copcDecodeStats =
        () => ({ started: decodeStats.started, done: decodeStats.done, inflight: decodeStats.started - decodeStats.done });

      tileset.attributeRange = async (name) => {
        const session = pageSessions.get(sid)!;
        const rootNode = session.nodes['0-0-0-0'];
        if (!rootNode) throw new Error('attributeRange: root node not yet loaded');
        const view = await Copc.loadPointDataView(session.getter, session.copc, rootNode);
        const g = view.getter(name);
        let lo = Infinity, hi = -Infinity;
        for (let i = 0; i < view.pointCount; i++) { const v = g(i); if (v < lo) lo = v; if (v > hi) hi = v; }
        return [lo, hi];
      };

      return tileset;
    } catch (err) {
      releaseSession(sid); // 초기화 실패 시 누적 상태 정리 후 표면화(누수·조용한 실패 방지)
      throw err;
    }
  },
};
