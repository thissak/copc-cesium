# ADR-004: "부드럽게" — 메모리·예산·동시성을 Cesium에 위임 (손코딩 스트리밍 primitive 기각)

- **상태**: Accepted (2026-06-17)
- **관련**: [ADR-001](001-provider-plugin-architecture-A.md) §결과의 "메모리 캐시 = 우리 일" 가정 정정 · CHANGELOG 2026-06-17 · 측정도구 `?soak`(`src/main.ts`)

## 맥락

주최사(Gaia3D) 공식 목표어 *"빠르고 **부드럽게**"*를 입상 집중 축으로 잡고, "부드럽게"를 단일책임 4모듈로 분해: ① 렌더 외형 ② 점 예산 ③ 요청 동시성 ④ 노드 캐시 eviction. ②③④는 STOP 신호어(스트리밍·캐싱·워커풀)라 **손코딩 전 (a) Cesium 내장 기능 확인 (b) 측정**을 강제했다.

ADR-001 §결과는 "LOD는 Cesium 위임, 단 **메모리 캐시는 우리 일**"로 봤다. 이 가정을 측정으로 검증했다.

## 결정

1. **④ eviction + ② 점 예산 = Cesium에 위임 (손코딩 LRU/point-budget 기각).** `Cesium3DTileset.cacheBytes`(기본 512MB) + `memoryAdjustedScreenSpaceError`가 *메모리 바운드 예산 + 화면 밖 타일 자동 unload*를 이미 수행. **실측 증명**(`?soak=autzen&cache=2`): 로드 점이 2MB 한도 초과 시 `tileUnload` 발동 → **우리 SW-pnts도 evict**, cesiumMB가 한도에서 plateau(무한 climb 없음), heap 평탄.
   - **단 범위 한정**: Cesium이 축출하는 것은 *렌더된 점 타일*. 서브페이지 **노드 메타데이터**(page/worker session.nodes)는 우리 장부라 Cesium 밖 → 여전히 누적(경량·미측정, [hierarchy-subpage-paging] wiki line 44 유효). 필요 시 *우리 장부 정리*이지 점 데이터 LRU가 아니다.
2. **③ 동시성 = Cesium RequestScheduler 설정 튜닝 (손코딩 워커풀 기각).** 근본원인 측정: 기본 server당 18 동시요청 → 워커 디코드의 S3 range fetch가 브라우저 6/host 한도에 큐잉 → 큐 대기시간이 per-attempt 8s 타임아웃(`FETCH_TIMEOUT_MS`)에 포함 → 헛타임아웃 → 재시도, 일부 소진 → 500(점군 구멍). 같은 항해서 `maximumRequestsPerServer` 18→6 시 **재시도 184→23·실패 4→0**(단 tilesReady 후반 7→0, **throughput↓ tradeoff**). → 워커풀이 아니라 **config 레버**(동시성 상한 / 타임아웃) 문제.
3. **정확한 노브값(maxReq·timeout·기본 cacheBytes)은 실 GPU+정상 네트워크 측정 후 확정.** 헤드리스 샌드박스는 S3가 느려/혼잡해 타임아웃 빈도를 과장하므로 값을 못 박지 않는다.

## 결과

- **(+)** 손코딩 예정이던 point-budget+LRU+워커풀 3종이 전부 "Cesium 설정+튜닝"으로 붕괴 — 신규 의존성·primitive 0. STOP 규칙(라이브러리/prior art 우선)의 모범 사례.
- **(+)** ① 렌더 기본값(EDL·attenuation·colorBy 'rgb')만 켜 demo가 무지개 점점이→사진급 RGB+EDL 입체(지구본 위 product-grade)로 — "부드럽게" LOD 단차 완화 + 데모 신뢰를 거의 공짜로.
- **(−)** ③ throttle은 안정성↔throughput tradeoff라 "6 고정"이 답이 아님. 실 GPU 데이터로 균형점(또는 timeout↑ 대안)을 잡아야 함 — 미결.
- **(−)** `RequestScheduler`는 전역 static — 라이브러리가 건드리면 앱 전역 영향. 채택 시 per-server override(우리 origin 스코프) 또는 `FETCH_TIMEOUT_MS` 조정으로 한정해야 함 — 설계 미정.
- ADR-001 §결과의 "메모리 캐시 = 우리 일" 가정은 *점 데이터에 한해* 본 ADR로 정정(Cesium 소관). 메타데이터 장부는 여전히 우리 몫.

## 다음

실 GPU에서 `?soak=millsite&secs=120`(기본 cacheBytes·기본 maxReq) → ③ 실제 빈도 + fps + 정상상태 메모리 천장 측정 → 그 데이터로 ③ 노브값·기본 cacheBytes·서브페이지 메타 상한 필요 여부를 확정.
