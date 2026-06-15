# CopcCesiumLab

> COPC 점군을 **사전 변환 없이** 브라우저에서 CesiumJS 위에 직접 띄우는 기술 프로토타입.

2026 오픈소스 개발자대회(KOSSA OSSP) 가이아쓰리디 지정과제 — *"COPC 데이터의 CesiumJS 가시화"* — 입상 가능성을 타진하기 위한 실험 랩.

## 이 랩의 진짜 목적

대회 우승작을 바로 만드는 게 아니라, **다음 4가지를 검증**하는 것:

1. **문제 인식** — 대용량 점군 웹 렌더에서 *뭐가* 어려운지 내 눈으로 확인한다.
2. **병목 추적** — "지금 뭐에 바운드됐나"를 4축(Network / Decode / CPU / GPU)으로 가른다.
3. **AI 협업** — 이 난이도의 문제를 AI와 함께 실제로 풀 수 있는가.
4. **정확한 디버깅** — 저피드백 도메인(WebGL·바이너리·좌표계)에서 추측 아닌 측정이 되는가.

→ 결론은 "할 만하다 / 못 하겠다 / 여기가 핵심이다"를 **데이터로** 내리는 것.

## 스택

| 요소 | 역할 |
|------|------|
| **CesiumJS** | 웹 3D 지구본 렌더 엔진 (LOD/컬링/SSE 머신 재사용 대상) |
| **copc.js** (`copc`) | COPC 옥트리/포인트 파싱 (TypeScript) |
| **laz-perf** | LAZ 청크 압축 해제 (WASM) |
| **Vite + TypeScript** | 번들/개발 서버 |

## 빠른 시작

```bash
npm install
npm run dev      # http://localhost:5173
```

## 4축 병목 프로파일링 (이 랩의 핵심 방법론)

언리얼 `stat unit`의 "뭐에 바운드됐나" 사고를 웹 4축으로 옮긴 것. 자세한 도구 매핑과 진단 프로토콜은 [`docs/PROFILING.md`](docs/PROFILING.md) 참조.

| 축 | 무엇 | 측정 도구 |
|----|------|-----------|
| ① Network/IO | COPC 노드 HTTP range fetch | DevTools Network 워터폴 |
| ② Decode | LAZ 압축 해제(WASM) | DevTools Performance 워커 트랙 |
| ③ CPU Main | 옥트리 순회·SSE·버퍼 업로드 | Performance 메인 스레드 |
| ④ GPU | 수백만 점 vertex/fill | Spector.js, timer query |

## 문서

- [`CLAUDE.md`](CLAUDE.md) — 운영 규칙 (빌드/스타일/금지)
- [`docs/PROGRESS.md`](docs/PROGRESS.md) — 페이즈 체크리스트
- [`docs/PROFILING.md`](docs/PROFILING.md) — 병목 진단 프로토콜
