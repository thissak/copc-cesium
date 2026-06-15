import { Viewer, Ion } from 'cesium';
import 'cesium/Build/Cesium/Widgets/widgets.css';

// 자체 ion 토큰이 있으면 .env 의 VITE_CESIUM_ION_TOKEN 로 주입 (없으면 Cesium 기본 dev 토큰).
const ionToken = import.meta.env.VITE_CESIUM_ION_TOKEN;
if (ionToken) Ion.defaultAccessToken = ionToken;

const viewer = new Viewer('app', {
  // Phase 0: 점군 작업에 불필요한 위젯은 끈다 (프로파일링 노이즈 감소).
  timeline: false,
  animation: false,
  geocoder: false,
  baseLayerPicker: false,
});

// ── 프로파일링 하네스 (docs/PROFILING.md) ──────────────────────────────
const scene = viewer.scene;
scene.debugShowFramesPerSecond = true; // 좌상단 FPS / ms 오버레이

// Phase 1 에서 COPC tileset 을 붙이면 아래를 켠다:
//   tileset.debugShowRenderingStatistics = true;  // 선택 타일 / 렌더 점 수 (기준선)
//   tileset.debugShowMemoryUsage = true;          // GPU 메모리
//   tileset.maximumScreenSpaceError = N;          // LOD 노브 (바운드 격리 테스트)

console.info(
  '%cCopcCesiumLab — Phase 0',
  'font-weight:bold;color:#4ea1ff',
  '\n• Cesium viewer booted. FPS 오버레이 ON.',
  '\n• 4축 병목 진단 프로토콜: docs/PROFILING.md',
  '\n• 다음: Phase 1 COPC 로드 (BP 조사 + 계획 승인 후 — STOP 규칙)',
);

// ── Phase 1 STUB: COPC 로드 ────────────────────────────────────────────
// STOP 규칙(CLAUDE.md): 스트리밍 / LOD / 캐싱 코드는 BP 조사 + 계획 승인 후 착수.
// copc.js getter(HTTP range) → 옥트리 순회 → 점 버퍼 → Cesium 렌더.
// async function loadCopc(url: string) { /* Phase 1 */ }

export { viewer };
