// 클릭한 점의 위치+LAS 속성 조회. Cesium 내장 pick/pickPosition + #1 batch table 만 사용(렌더러 손코딩 0).
// 페이지측 헬퍼(Cesium import 허용, copc-style.ts 와 동일 레이어).
import { Cartesian3, Cartographic, Math as CesiumMath } from 'cesium';
import type { Cartesian2, Cesium3DTileFeature, Cesium3DTileset, Scene } from 'cesium';

export interface PickedPoint {
  position?: Cartesian3; // ECEF (scene.pickPosition; 미지원/실패 시 undefined)
  cartographic?: Cartographic; // lon/lat(rad)·height(m), position 에서 파생
  featureId?: number; // tile-local batch id (전역·안정 식별자 아님). batch table 없으면 부재.
  attributes: Record<string, number | string>; // 노출된 LAS 속성. batch table 없으면 {}.
}

/**
 * windowPosition 의 점이 `tileset` 소유면 그 점의 위치+속성을, 아니면 undefined.
 * globe 관통·하늘·타 tileset 은 undefined 로 걸러진다.
 */
export function pickPoint(
  tileset: Cesium3DTileset,
  scene: Scene,
  windowPosition: Cartesian2,
): PickedPoint | undefined {
  const picked = scene.pick(windowPosition) as Cesium3DTileFeature | undefined;
  // 소유권: 우리 tileset 의 feature 만. globe/하늘/타 tileset 은 거른다.
  if (!picked || picked.primitive !== tileset) return undefined;

  // pickPosition 은 타입상 Cartesian3 지만 런타임엔 depth 미가용 시 undefined 를 반환한다.
  // 아래 truthiness 가드를 non-null 단언으로 "단순화" 하지 말 것 — degraded 위치(undefined)가 조용한 실패로 둔갑한다.
  const position = scene.pickPositionSupported ? scene.pickPosition(windowPosition) : undefined;
  const cartographic = position ? Cartographic.fromCartesian(position) : undefined;

  // batch table 없는 점군(attributes:[] 또는 큐레이션 차원 전무)에선 Cesium 이 feature 가 아닌
  // 평범한 content pick 객체({primitive: tileset, …})를 준다 — getProperty*/featureId 부재.
  // .primitive===tileset 라 위 소유권 가드는 통과하므로, 여기서 capability 로 거르지 않으면 crash 한다.
  if (typeof picked.getPropertyIds !== 'function') return { position, cartographic, attributes: {} };

  const attributes: Record<string, number | string> = {};
  for (const id of picked.getPropertyIds()) attributes[id] = picked.getProperty(id);

  return { position, cartographic, featureId: picked.featureId, attributes };
}

export interface SnappedPoint {
  position: Cartesian3; // ECEF (스냅된 실제 점)
  cartographic: Cartographic; // lon/lat(rad)·height(m)
  attributes: Record<string, number | string>; // 노출된 LAS 속성(없으면 {})
  distanceM: number; // 씨앗(pickPosition)↔스냅점 ECEF 거리(m)
}

/**
 * windowPosition 의 점이 `tileset` 소유면, 옥트리 풀해상도 최근접 실제 점으로 스냅해 반환 (이슈 #3-B).
 * `query` 는 WGS84 씨앗 → 워커 nearestPoint(데이터 레이어). 씨앗 없음/미소유/스냅 실패 → undefined.
 *
 * **한계(PR#21 R2)**: 씨앗을 포함하는 *가장 깊은 단일 노드* 안에서만 최근접을 찾는다(이웃 노드 미검색).
 * 노드 경계에 바싹 붙은 클릭은 진짜 전역 최근접 점이 인접 노드에 있어 ~노드 spacing(autzen 실측 최대 ~0.14m)
 * 만큼 빗날 수 있다 — "그 지점 로컬 풀해상도 근사 스냅"이지 전역 최근접 보장 아님(이웃 검색=후속 enhancement).
 */
export async function snapPoint(
  tileset: Cesium3DTileset,
  scene: Scene,
  windowPosition: Cartesian2,
  query: (seed: { lon: number; lat: number; height: number }) => Promise<{ lon: number; lat: number; height: number; attributes: Record<string, number> } | null>,
): Promise<SnappedPoint | undefined> {
  const picked = scene.pick(windowPosition) as { primitive?: unknown } | undefined;
  if (!picked || picked.primitive !== tileset) return undefined; // 소유권 가드(#3-A 와 동일)
  const seedPos = scene.pickPositionSupported ? scene.pickPosition(windowPosition) : undefined;
  if (!seedPos) return undefined; // depth 미가용(빈틈/하늘) → 명시적 부재
  const seedCarto = Cartographic.fromCartesian(seedPos);
  const hit = await query({
    lon: CesiumMath.toDegrees(seedCarto.longitude),
    lat: CesiumMath.toDegrees(seedCarto.latitude),
    height: seedCarto.height,
  });
  if (!hit) return undefined; // 노드/점 없음
  const position = Cartesian3.fromDegrees(hit.lon, hit.lat, hit.height);
  return {
    position,
    cartographic: Cartographic.fromCartesian(position),
    attributes: hit.attributes,
    distanceM: Cartesian3.distance(seedPos, position),
  };
}
