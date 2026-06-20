# ADR-004: "부드럽게" — 메모리·예산·동시성을 Cesium에 위임 (손코딩 스트리밍 primitive 기각)

- **상태**: Accepted (2026-06-17) · **③ 동시성 노브값·메커니즘 보강 (2026-06-18, 문서 하단)**
- **관련**: [ADR-001](001-provider-plugin-architecture-A.md) §결과의 "메모리 캐시 = 우리 일" 가정 정정 · CHANGELOG 2026-06-17~18 · 측정도구 `?soak`(`src/main.ts`) · 동시성 옵션 commit `923d0ed`

## 맥락

주최사(Gaia3D) 공식 목표어 *"빠르고 **부드럽게**"*를 입상 집중 축으로 잡고, "부드럽게"를 단일책임 4모듈로 분해: ① 렌더 외형 ② 점 예산 ③ 요청 동시성 ④ 노드 캐시 eviction. ②③④는 STOP 신호어(스트리밍·캐싱·워커풀)라 **손코딩 전 (a) Cesium 내장 기능 확인 (b) 측정**을 강제했다.

ADR-001 §결과는 "LOD는 Cesium 위임, 단 **메모리 캐시는 우리 일**"로 봤다. 이 가정을 측정으로 검증했다.

## 결정

1. **④ eviction + ② 점 예산 = Cesium에 위임 (손코딩 LRU/point-budget 기각).** `Cesium3DTileset.cacheBytes`(기본 512MB) + `memoryAdjustedScreenSpaceError`가 *메모리 바운드 예산 + 화면 밖 타일 자동 unload*를 이미 수행. **실측 증명**(`?soak=autzen&cache=2`): 로드 점이 2MB 한도 초과 시 `tileUnload` 발동 → **우리 SW-pnts도 evict**, cesiumMB가 한도에서 plateau(무한 climb 없음), heap 평탄.
   - **단 범위 한정**: Cesium이 축출하는 것은 *렌더된 점 타일*. 서브페이지 **노드 메타데이터**(page/worker session.nodes)는 우리 장부라 Cesium 밖 → 여전히 누적(경량·미측정, [hierarchy-subpage-paging] wiki line 44 유효). 필요 시 *우리 장부 정리*이지 점 데이터 LRU가 아니다.
2. **③ 동시성 = Cesium RequestScheduler 설정 튜닝 (손코딩 워커풀 기각).** 근본원인 측정: 기본 server당 18 동시요청 → 워커 디코드의 S3 range fetch가 브라우저 6/host 한도에 큐잉 → 큐 대기시간이 per-attempt 8s 타임아웃(`FETCH_TIMEOUT_MS`)에 포함 → 헛타임아웃 → 재시도, 일부 소진 → 500(포인트클라우드 구멍). 같은 항해서 `maximumRequestsPerServer` 18→6 시 **재시도 184→23·실패 4→0**(단 tilesReady 후반 7→0, **throughput↓ tradeoff**). → 워커풀이 아니라 **config 레버**(동시성 상한 / 타임아웃) 문제.
3. **정확한 노브값(maxReq·timeout·기본 cacheBytes)은 실 GPU+정상 네트워크 측정 후 확정.** 헤드리스 샌드박스는 S3가 느려/혼잡해 타임아웃 빈도를 과장하므로 값을 못 박지 않는다.

## 결과

- **(+)** 손코딩 예정이던 point-budget+LRU+워커풀 3종이 전부 "Cesium 설정+튜닝"으로 붕괴 — 신규 의존성·primitive 0. STOP 규칙(라이브러리/prior art 우선)의 모범 사례.
- **(+)** ① 렌더 기본값(EDL·attenuation·colorBy 'rgb')만 켜 demo가 무지개 점점이→사진급 RGB+EDL 입체(지구본 위 product-grade)로 — "부드럽게" LOD 단차 완화 + 데모 신뢰를 거의 공짜로.
- **(−)** ③ throttle은 안정성↔throughput tradeoff라 "6 고정"이 답이 아님. 실 GPU 데이터로 균형점(또는 timeout↑ 대안)을 잡아야 함 — 미결.
- **(−)** `RequestScheduler`는 전역 static — 라이브러리가 건드리면 앱 전역 영향. 채택 시 per-server override(우리 origin 스코프) 또는 `FETCH_TIMEOUT_MS` 조정으로 한정해야 함 — 설계 미정.
- ADR-001 §결과의 "메모리 캐시 = 우리 일" 가정은 *점 데이터에 한해* 본 ADR로 정정(Cesium 소관). 메타데이터 장부는 여전히 우리 몫.

## 다음

실 GPU에서 `?soak=millsite&secs=120`(기본 cacheBytes·기본 maxReq) → ③ 실제 빈도 + fps + 정상상태 메모리 천장 측정 → 그 데이터로 ③ 노브값·기본 cacheBytes·서브페이지 메타 상한 필요 여부를 확정.

---

## 보강 (2026-06-18): ③ 동시성 노브값·메커니즘 확정

원 결정이 "실 GPU 측정 후"로 미룬 ③ 노브값과, 결과 −항목으로 남긴 *전역 static 오염 회피 설계 미정*·*throughput tradeoff* 를 측정 + BP 조사로 닫는다.

**근본원인 정밀화 — "HTTP/2 가정값을 HTTP/1.1 소스에 쓴 것".** Cesium 호스트당 기본 18은 **HTTP/2 멀티플렉싱 가정값**이다(v1.113에서 6→18 상향, [릴리스 노트](https://github.com/CesiumGS/cesium/releases/tag/1.113)). 그러나 S3 REST 엔드포인트는 **HTTP/1.1**(`curl --http2` 강제해도 1.1 협상, ALPN h2 미광고)이라 브라우저가 호스트당 ~6 연결로 제한 → 18은 과구독 → 큐 대기 + 8s 타임아웃 → 재시도 폭풍. 즉 18은 *우리 환경에 틀린 기본값*이지 동시성 자체의 결함이 아니다.

**노브값 = 6 (per-host).** BP 조사(context7 + 5개 라이브러리 소스 직독): per-host 캡을 두는 곳은 **iTowns 6**·Giro3D 10·**Cesium 1.113 이전 6**; Potree/loaders.gl/3DTilesRendererJS 는 per-host 개념 없이 전역캡(4/64/25)으로 브라우저의 ~6/origin 한도에 암묵 의존. 6 = 브라우저 HTTP/1.1 호스트당 연결 한도와 일치하고 mature-lib 범위(6~10)의 보수적 하단.

**메커니즘 = `RequestScheduler.requestsByServer[콘텐츠호스트]` (전역 미오염).** 원 결과 −항목 *"전역 static — per-server override(우리 origin 스코프)로 한정해야, 설계 미정"* 을 그대로 해결. 콘텐츠(`/__copc-real/`)는 앱 origin 서빙이므로 **그 호스트 키에만** per-server override를 둔다(Cesium 공식 문서가 `requestsByServer`를 정확히 이 용도로 제공 — "useful when streaming from a known server"). 전역 `maximumRequestsPerServer` 는 건드리지 않아 소비자 앱의 다른 서버 요청 영향 0. 손코딩 워커풀/세마포어 0 — STOP 규칙 충족.

**원 "throughput↓ tradeoff" 우려 반증.** 고밀도 헤드리스 soak 재측정(MSSE=2·near=0.04): range 재시도 **85(타임아웃 58)@기본18 → 1@maxReq6**, tileFailed(포인트클라우드 구멍)은 양쪽 **0**(복원력 레이어가 흡수 — ③은 정확성 갭이 아니라 지연/throughput 문제로 좁혀짐). 그리고 6이 **throughput 도 높았다**(30s간 39→49 타일): 과동시성의 8s 타임아웃 낭비(받던 바이트 버리고 재시도)가 처리량을 더 깎기 때문. → 원 ADR의 *"6 고정이 답이 아님"* 은 **HTTP/1.1 range 소스 한해 해소**(6이 우수). HTTP/2 CDN 뒤면 옵션으로 상향.

**출하.** `CopcTileset.fromUrl(url, { maxRequestsPerServer })` 옵션, 기본 6, `0` 이하면 미설정(Cesium 기본 유지·escape hatch). commit `923d0ed`. 검증: 새 기본값 sofi 고밀도 soak 재시도 4(타임아웃 1)·실패 0, build·build:lib·verify C1 PASS.

**조정 사항.** `FETCH_TIMEOUT_MS`(8s)는 안전 backstop 으로 유지 — 동시성 6에선 타임아웃이 애초에 안 난다. 실 GPU **절대 fps headline** 측정은 여전히 유용하나(부드럽게 정량 증거) ③ 노브 결정과는 무관해졌다. (헤드리스 software-GPU 는 traversal 이 느려 기본 MSSE 8 에선 이 regime 미재현 → MSSE=2 강제 필요. 실 GPU 는 빠른 traversal 로 자연 진입하므로 6 근거가 오히려 더 강함.)

→ **③ 동시성 = 닫힘.** (②④ 는 원 결정대로 Cesium 위임 유지.)
