# Phase 2 (COPC Provider 스트리밍) Handoff

작성 2026-06-16. 스파이크 완료, 본편 조립 착수 직전 상태.

## 완료된 작업
- 갭 검증 + 아키텍처 결정([ADR-001](../adr/001-provider-plugin-architecture-A.md)): 결과물 = `CopcTileset.fromUrl()` 플러그인, A안(동적 Cesium3DTileset, LOD는 Cesium 위임)
- 스파이크 3건 PASS ([RESULTS](../RESULTS.md)):
  - ① 런타임 pnts(data URI) → Cesium3DTileset 로드 (`tileLoad:1`) — `src/pnts.ts`, `?spike`
  - ② Cesium은 타일 content를 **XHR**로 요청 (fetch 아님) — 자가진단 `?spike2`
  - ③ **서비스워커**가 XHR 가로채 요청 시점 pnts 응답 (`tileLoad:1`) — `public/copc-sw.js`, `?spike3`
- 검증 하네스: `npm run verify`(정확성·timings) · `npm run sweep`(데이터축) · `?bench`(렌더 fps, 실 GPU)

## 다음 작업 (본편 조립 — 전부 "알려진 일")
- COPC 디코드(copc.js/laz-perf)를 **서비스워커로 이동** — 노드 키별 range fetch + 디코드 + pnts 생성
- COPC 옥트리 전체 → **동적 tileset.json 트리** (노드별 boundingVolume, geometricError = `spacing / 2^깊이`)
- LRU 캐시 + 컴팩트 typed buffer (Phase 1 교훈: 점당 객체 금지)
- `CopcTileset.fromUrl(url, { pointSize, colorBy, projFunc, maximumScreenSpaceError })` API 정리

## 알려진 이슈 / 주의
- Cesium은 content를 XHR로 가져옴 → 가로채기는 fetch 패치 ❌, **서비스워커 필수**
- 정밀도: pnts에 **RTC_CENTER 필수**(jitter 방지). CRS는 proj4 — COMPD_CS는 내부 PROJCS 추출 + 선형단위 Z 보정 (`src/copc-core.ts`)
- 대회 범위: 버전 유지보수(허들#5) OUT, 실데이터 동물원(#4) 완화. correctness(#1·#2)는 안 깎음
- 실 GPU fps는 헤드리스 측정 불가 → 사용자 머신(`?bench`)

## 핵심 결정 사항
- 비교 기준점 = 오픈 동료(Giro3D/Potree), **Eptium 아님** (Eptium은 실현가능성 증거지 성능 잣대 아님)
- STOP 규칙: 본편 착수 전 계획 + 검증기준 승인 필요
