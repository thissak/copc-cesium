// 클릭한 점의 위치+LAS 속성 조회. Cesium 내장 pick/pickPosition + #1 batch table 만 사용(렌더러 손코딩 0).
// 페이지측 헬퍼(Cesium import 허용, copc-style.ts 와 동일 레이어).
import { Cartographic } from 'cesium';
import type { Cartesian2, Cartesian3, Cesium3DTileFeature, Cesium3DTileset, Scene } from 'cesium';

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
