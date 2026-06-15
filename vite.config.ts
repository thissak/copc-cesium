import { defineConfig } from 'vite';
import cesium from 'vite-plugin-cesium';

// vite-plugin-cesium: Cesium 정적 에셋(Workers/Assets/Widgets/ThirdParty) 복사 +
// CESIUM_BASE_URL 주입을 자동 처리한다.
export default defineConfig({
  plugins: [cesium()],
  server: {
    // COPC 원격 호스트가 CORS/range를 막을 때 프록시를 여기에 둔다 (Phase 1).
  },
});
