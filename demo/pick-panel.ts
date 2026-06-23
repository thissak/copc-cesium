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
  handler.setInputAction(async (movement: { position: Cartesian2 }) => {
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
      // #3-B: 옥트리 풀해상도 최근접점 스냅(거리 포함). pickPoint 위치와 별도 표기.
      const snapped = await (tileset as unknown as {
        snapPoint?: (scene: typeof viewer.scene, win: typeof movement.position) => Promise<{ cartographic: { longitude: number; latitude: number; height: number }; distanceM: number } | undefined>;
      }).snapPoint?.(viewer.scene, movement.position);
      if (snapped) {
        const d2 = (r: number) => (r * 180 / Math.PI).toFixed(6);
        lines.push(`snap: ${d2(snapped.cartographic.longitude)}°, ${d2(snapped.cartographic.latitude)}°, ${snapped.cartographic.height.toFixed(2)}m (Δ${snapped.distanceM.toFixed(2)}m)`);
      }
      panel.textContent = lines.join('\n');
      panel.style.display = 'block';
    } catch (e) {
      console.error('[snap]', e);
    }
  }, ScreenSpaceEventType.LEFT_CLICK);
}
