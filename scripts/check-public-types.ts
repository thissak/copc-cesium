import type { Cartesian2, Scene } from 'cesium';
import { CopcTileset, rampStyle } from '../src/index';

// README에 공개된 tileset 헬퍼가 fromUrl 반환형에 포함되는지 컴파일로 검증한다.
// 실행 테스트가 아니라 `tsc --noEmit` 전용 소비자 계약 픽스처이다.
async function consumerContract(scene: Scene, windowPosition: Cartesian2): Promise<void> {
  const tileset = await CopcTileset.fromUrl('https://example.com/cloud.copc.laz');
  const snapped = await tileset.snapPoint(scene, windowPosition);
  const range = await tileset.attributeRange('Intensity');
  tileset.style = rampStyle('Intensity', range);
  void snapped;
}

void consumerContract;
