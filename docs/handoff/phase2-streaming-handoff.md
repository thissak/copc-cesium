# Phase 2 (COPC Provider 스트리밍) Handoff

갱신 2026-06-16. 핵심 기능 + 공개 API 작동. 성능·마감만 남음.

## 완료된 작업
- 아키텍처: [ADR-001](../adr/001-provider-plugin-architecture-A.md)(결과물=`CopcTileset.fromUrl()`, A안) + [ADR-002](../adr/002-service-worker-tile-interception.md)(서비스워커 가로채기 + 페이지 디코드 라우팅)
- 스파이크 ①②③: 런타임 pnts→Cesium 로드 / Cesium은 XHR 요청 / 서비스워커 온디맨드 가로채기 ([RESULTS](../RESULTS.md))
- **본편 ① 진짜 COPC via SW** (`?spike4`) — 진짜 Autzen 노드를 SW 경로로 온디맨드 렌더
- **본편 ② 옥트리 LOD 스트리밍** (`?spike5`) — 옥트리(278노드)→동적 tileset 트리, Cesium SSE가 24노드만 선택 (`tileLoad:24/fail:0`)
- **본편 ④코어 `CopcTileset.fromUrl()` 공개 API** (`src/copc-tileset.ts`) + 기본 데모 페이지
- 타일 LOD 경계 단차: boundingVolume 높이를 데이터 Z로 조여 완화
- 코드 맵: `copc-core.ts`(openCopc/decodeNode) · `tileset.ts`(옥트리→tileset) · `copc-tileset.ts`(공개 API) · `pnts.ts`(pnts 생성) · `public/copc-sw.js`(SW)
- 검증: `npm run verify`/`sweep`, `?bench`(fps), `?spike`~`?spike5`, 기본=데모

## 다음 작업 (성능·마감)
- ~~③-A 성능: 디코드 → Web Worker 이동 + 컴팩트 buffer~~ **완료(2026-06-17)** — `comlink` 단일 워커 + `POSITION_QUANTIZED`. `src/decode.worker.ts`·`src/pnts-quantized.ts`, C1~C6 PASS.
- **③-B (측정 후 판단)**: LRU 캐시(`lru-cache`)·워커풀(`workerpool`). BP상 Cesium `cacheBytes`와 중복 가능성 → **착수 전 측정**(재디코드 빈도/디코드 큐잉). 손코딩 금지·STOP 규칙.
- **④ 마감**: ~~`options`~~ **options 완료(2026-06-17)** — `pointSize`/`attenuation`/`eyeDomeLighting`/`colorBy`. `projFunc`(JS함수)는 드롭 — prior art(Giro3D `registerCRS`·Potree)는 직렬화 CRS 문자열을 씀(레퍼런스 검증). 오버라이드 필요시 `sourceCrs` 문자열/워커-사이드 팩토리로 후속. (TIFFImageryProvider의 projFunc는 메인스레드 1회 팩토리였음 — ADR-001 §4 정정). **남음**: README/라이선스 + 데모 페이지 다듬기
- **단차 마무리**: Z조임 fix 효과 실 GPU 확인 → 남으면 attenuation/EDL 옵션 ON
- **실 GPU 대용량 fps** 측정 (헤드리스 불가) — ③-A 효과(메인스레드 끊김↓) 정량 확인 겸

## 알려진 이슈 / 주의
- 디코드 세션이 워커·페이지 양쪽에 1개씩(각자 `openCopc`) → 헤더+옥트리 fetch 2회(1회성·경량). 페이지 세션은 디코드 안 함(WASM 불필요)
- 양자화 정밀도는 per-tile QUANTIZED_VOLUME(타일 ECEF extent)에 상대 → 도시 스케일 cm~mm. 전역 단일 볼륨 쓰면 정밀도 붕괴(주의)
- **stale SW 제어권 race**: `register` 전 unregister 또는 `reg.update()` + controllerchange 대기
- Cesium은 content를 XHR로 가져옴 → 가로채기는 fetch 패치 ❌, **서비스워커 필수**
- 정밀도: pnts에 **RTC_CENTER 필수**. CRS는 proj4 (COMPD_CS는 PROJCS 추출 + 단위보정, `copc-core.ts`)
- 인접 타일 LOD 단차: 일부는 octree LOD 본질 특성(attenuation/EDL로 *가림*), 일부는 bbox 헐거움(조임으로 완화)
- 대회 범위: 버전 유지보수(허들#5) OUT, 실데이터 동물원(#4) 완화. correctness 안 깎음

## 핵심 결정
- 비교 기준점 = 오픈 동료(Giro3D/Potree), Eptium 아님
- STOP 규칙: ③ 착수 전 계획 + 검증기준 승인
