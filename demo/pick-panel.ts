// 클릭 시 그 점의 경위도·고도 + LAS 속성을 우상단 패널에 표시. 빈 클릭(하늘/globe)은 숨김.
import { Math as CesiumMath, ScreenSpaceEventHandler, ScreenSpaceEventType } from 'cesium';
import type { Cartesian2, Cesium3DTileset, Viewer } from 'cesium';
import { pickPoint } from '../src/picking';

export function installPickPanel(viewer: Viewer, tileset: Cesium3DTileset): void {
  const panel = document.createElement('div');
  panel.id = 'pick-panel';
  panel.style.cssText =
    'position:absolute;top:8px;right:8px;padding:8px 10px;background:rgba(0,0,0,0.7);' +
    'color:#fff;font:12px/1.5 monospace;border-radius:4px;max-width:280px;display:none;white-space:pre;z-index:10;';
  document.body.appendChild(panel);

  const handler = new ScreenSpaceEventHandler(viewer.canvas);
  // 클릭마다 토큰을 올린다 — 느린 snap 응답이 그 사이 찍은 다른 점의 패널에 붙는 걸 막는다.
  let clickToken = 0;
  handler.setInputAction(async (movement: { position: Cartesian2 }) => {
    const token = ++clickToken;
    try {
      const hit = pickPoint(tileset, viewer.scene, movement.position);
      if (!hit) {
        panel.style.display = 'none';
        return;
      }
      const lines: string[] = [];
      if (hit.cartographic) {
        lines.push(
          `Lon ${CesiumMath.toDegrees(hit.cartographic.longitude).toFixed(5)}°`,
          `Lat ${CesiumMath.toDegrees(hit.cartographic.latitude).toFixed(5)}°`,
          `Height ${hit.cartographic.height.toFixed(1)} m`,
        );
      } else {
        lines.push('position: n/a');
      }
      for (const [k, v] of Object.entries(hit.attributes)) lines.push(`${k}: ${v}`);
      // 확보된 정보는 즉시 그린다 (이슈 #32). snapPoint 는 옥트리 최심 노드를 그때 받아
      // 디코드하므로 수 초가 걸린다 — 그걸 기다리느라 클릭 피드백 전체를 막으면 안 된다.
      panel.textContent = lines.join('\n');
      panel.style.display = 'block';
      // #3-B: 옥트리 풀해상도 최근접점 스냅(거리 포함). pickPoint 위치와 별도 표기.
      const snapped = await (tileset as unknown as {
        snapPoint?: (scene: typeof viewer.scene, win: typeof movement.position) => Promise<{ cartographic: { longitude: number; latitude: number; height: number }; distanceM: number } | undefined>;
      }).snapPoint?.(viewer.scene, movement.position);
      if (snapped && token === clickToken) {
        // 그 사이 다른 점을 찍었으면 이 응답은 버린다(늦게 온 값이 새 패널을 오염시키지 않게).
        const d2 = (r: number) => (r * 180 / Math.PI).toFixed(6);
        lines.push(`snap: ${d2(snapped.cartographic.longitude)}°, ${d2(snapped.cartographic.latitude)}°, ${snapped.cartographic.height.toFixed(2)}m (Δ${snapped.distanceM.toFixed(2)}m)`);
        panel.textContent = lines.join('\n');
      }
    } catch (e) {
      console.error('[snap]', e);
    }
  }, ScreenSpaceEventType.LEFT_CLICK);
}
