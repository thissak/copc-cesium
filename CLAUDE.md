# CopcCesiumLab — 운영 규칙

COPC 점군을 사전 변환 없이 CesiumJS에 직접 렌더하는 기술 프로토타입. (대회 입상 타진용 실험 랩)
성격: 학습·사이드. SSOT는 이 파일 → `docs/PROGRESS.md` → `docs/CHANGELOG.md` 순.

## 빌드 / 실행

```bash
npm install
npm run dev      # 개발 서버 (http://localhost:5173)
npm run build    # 프로덕션 번들
npm run preview  # 빌드 결과 미리보기
```

## 스택

- CesiumJS (렌더), copc.js(`copc`) + laz-perf(파싱/디코드), Vite + TypeScript.
- Cesium 정적 에셋은 `vite-plugin-cesium`가 처리.

## 코드 스타일

- TypeScript strict. 기존 파일 스타일을 따른다.
- 주변 코드를 "개선"하지 않는다. 변경 라인은 요청에 직결되어야 한다.

## 금지 / STOP 규칙

- **스트리밍 / LOD / 캐싱 / 상태동기화 / 워커 풀** 코드는 손코딩 전 STOP.
  먼저 (a) 기존 라이브러리/prior art가 푸는지 확인, (b) 손수 만든 primitive는 정당화.
  계획 + 검증기준(Acceptance Criteria) 제시 → 승인 후 착수.
- 추측으로 단정 금지. 병목/동작은 **측정**으로 말한다 (`docs/PROFILING.md` 4축).
- 대용량 COPC 원본을 repo에 커밋하지 않는다 (`data/`는 gitignore).

## 핵심 설계 가설 (검증 대상)

- **Cesium의 3D Tiles 렌더러 재사용** — COPC 옥트리를 메모리상 가짜 tileset으로 래핑해
  Cesium의 SSE/컬링/LOD 머신을 공짜로 쓴다. vs. WebGL custom primitive 직접 구현.
  → 어느 쪽이 맞는지는 프로토타입 측정으로 결정한다.
