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
- **③ 성능**: 디코드를 페이지 메인스레드 → **Web Worker**로 이동 (대용량 UI 끊김 방지) + **LRU 캐시**(메모리 상한) + 컴팩트 buffer
- **④ 마감**: `options`(colorBy/pointSize/projFunc/attenuation) + README/라이선스 + 데모 페이지 다듬기
- **단차 마무리**: Z조임 fix 효과 실 GPU 확인 → 남으면 attenuation/EDL 옵션 ON
- **실 GPU 대용량 fps** 측정 (헤드리스 불가)

## 알려진 이슈 / 주의
- 디코드 현재 메인스레드 → ③에서 Worker 필수
- **stale SW 제어권 race**: `register` 전 unregister 또는 `reg.update()` + controllerchange 대기
- Cesium은 content를 XHR로 가져옴 → 가로채기는 fetch 패치 ❌, **서비스워커 필수**
- 정밀도: pnts에 **RTC_CENTER 필수**. CRS는 proj4 (COMPD_CS는 PROJCS 추출 + 단위보정, `copc-core.ts`)
- 인접 타일 LOD 단차: 일부는 octree LOD 본질 특성(attenuation/EDL로 *가림*), 일부는 bbox 헐거움(조임으로 완화)
- 대회 범위: 버전 유지보수(허들#5) OUT, 실데이터 동물원(#4) 완화. correctness 안 깎음

## 핵심 결정
- 비교 기준점 = 오픈 동료(Giro3D/Potree), Eptium 아님
- STOP 규칙: ③ 착수 전 계획 + 검증기준 승인
