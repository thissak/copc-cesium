# CopcCesiumLab 학습 위키

> 코드·ADR·PROGRESS(SoT)를 읽고 **내 언어로 합성한 학습 층**. 사본이 아니라 의미·연결·약점을 적는다.
> 구체 수치/파일 경로는 본문이 아니라 각 페이지의 `## 참고 (RAW 인용)` 에만 둔다.

마지막 갱신: 2026-06-22

## 개념 페이지

| slug | 한 줄 | status |
|------|-------|--------|
| [[decode-in-worker]] | 디코드는 SW도 메인스레드도 아닌 Web Worker에서 돈다 | active |
| [[hierarchy-subpage-paging]] | 깊은 옥트리를 외부 tileset proxy로 본 만큼만 lazy 확장 | active |
| [[range-coalescing]] | 인접 노드 range를 1회 GET으로 묶어 round-trip을 줄인다 (deep-load 레버) | active |
| [[coalescing-inflight-race]] | 진행 중 묶음은 "받아온 범위"로 잘라야 한다 (in-flight/rebuild 레이스·디버깅 교훈) | active |
| [[crs-georeferencing]] | WKT로 지구 위 제자리에 놓되, 없으면 조용히 틀리지 말고 fail-loud + override | active |
| [[reproject-grid-approximation]] | 점별 proj4가 비싸 — 앵커 격자 + bilinear로 어림하고 위험하면 폴백 (amortization) | active |

## 작성 예정 (stub — 의도된 미작성)

- `service-worker-tile-interception` (아직 없음) — SW가 타일 요청을 가로채 페이지로 라우팅
- `copc-octree-lod-streaming` (아직 없음) — Cesium 위임 LOD로 옥트리 노드 스트리밍

## 메타

- [작성 가이드](writing-guide.md) — 이 위키 페이지를 어떻게 쓰는지 (frontmatter·본문 규약·변동성 규칙)
