# 병목 진단 프로토콜 (4축)

> 언리얼 `stat unit`의 "지금 뭐에 바운드됐나" 사고를 웹/Cesium 4축으로 옮긴 것.
> 추측 금지 — 측정으로 말한다.

## 4축 (게임은 보통 2축, 점군 스트리밍은 4축)

| 축 | 무엇 | 언리얼 대응 |
|----|------|-----------|
| ① Network/IO | COPC 노드를 HTTP range로 fetch | (신규) 스트리밍 레벨 로딩 |
| ② Decode/Worker | LAZ 압축 해제(laz-perf WASM) + 파싱 | 에셋 디컴프레션/메시 빌드 |
| ③ CPU Main | 옥트리 순회, SSE 계산, 버퍼 업로드 | game + render thread |
| ④ GPU | 수백만 점 vertex throughput, point sprite fill | GPU |

## 도구 매핑 (언리얼 → 웹/Cesium)

| 언리얼 | 웹/Cesium |
|--------|-----------|
| `stat unit` (Frame/Game/Draw/GPU 분해) | Chrome DevTools → **Performance** 녹화 (메인=game+render thread, 워커=별도 트랙) |
| `stat scenerendering` (draw call) | **Spector.js** (RenderDoc-lite, WebGL 콜·draw call·중복 상태 캡처) |
| RenderDoc / GPU Visualizer | Spector.js + (Mac) **Xcode Metal 캡처** (브라우저 GPU 작업을 Metal로) |
| `ProfileGPU` GPU 타임라인 | `EXT_disjoint_timer_query_webgl2` (GPU timer query — 브라우저는 빈약함) |
| 스트리밍 IO 스톨 | DevTools → **Network** 워터폴 (in-flight, TTFB, pending) |
| visible prims | `tileset.debugShowRenderingStatistics = true` (선택 타일/렌더 점 수) |
| GPU 메모리 | `tileset.debugShowMemoryUsage = true` |
| LOD screen size | `tileset.maximumScreenSpaceError` (낮을수록 디테일↑·부하↑) |
| `stat fps` | `scene.debugShowFramesPerSecond = true` |
| 프러스텀/컬링 디버그 | `scene.debugShowFrustumPlanes`, `tileset.debugShowBoundingVolume` |

## 첫 30분 진단 프로토콜

1. `tileset.debugShowRenderingStatistics = true` → 렌더되는 **점 개수**부터 본다 (모든 판단의 기준선).
2. DevTools **Performance** 3~5초 녹화 (카메라 움직이며):
   - 메인 스레드 꽉 참 → **③ CPU 바운드** (어떤 함수? 디코드/업로드/순회)
   - 워커 트랙 100% 핀 → **② 디코드 바운드**
   - 메인·워커 한가한데 끊김 → **④ GPU 의심**
3. DevTools **Network** 동시에 → 요청 줄서기(pending 다발)·긴 TTFB → **① IO 바운드**.

## 바운드 격리 테스트 (언리얼 이분 탐색 그대로)

- `maximumScreenSpaceError` ↑ (점 예산↓) → FPS 급등이면 ③/④ (점 개수에 묶임)
- point size ↓ → FPS 급등이면 ④ fill-rate(overdraw) 바운드
- 카메라 정지 시에도 느림 → 렌더(③④) / 움직일 때만 느림 → 로딩·디코드(①②)
- 로컬 파일 vs 원격 차이 큼 → ① 확정
