// copc-cesium — 공개 진입점 (라이브러리 표면).
// CesiumJS 에서 COPC 를 변환 없이 스트리밍하는 플러그인.
//
//   import { CopcTileset } from 'copc-cesium';
//   const tileset = await CopcTileset.fromUrl(url);
//   viewer.scene.primitives.add(tileset);
//
// 주의: 콘텐츠 스트리밍에 서비스워커가 필요하다. 패키지의 `copc-sw.js` 를
// 소비자 origin 의 콘텐츠 경로를 덮는 scope(기본 root)에 서빙해야 한다. (README 참조)

export { CopcTileset } from './copc-tileset';
export type { CopcTilesetOptions } from './copc-tileset';
export type { ColorBy } from './colors';
