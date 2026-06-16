# CHANGELOG

날짜별 변경 내역 + 결정 사유. 최신이 위.

### 2026-06-16
- [chore] 프로젝트 스캐폴드 — Vite + CesiumJS + copc.js + 4축 프로파일링 하네스 (Phase 0). 실브라우저 부팅 검증.
- [feat] Phase 1 갭 실증 — naive COPC→Cesium baseline + 헤드리스 `verify`/`sweep`/`?bench`. C1 정확성(georef=Autzen), C2 naive 벽(~2~3M점), C3 재현 PASS. **벽의 원인은 GPU가 아니라 `PointPrimitiveCollection` 점당 오버헤드(메모리 1KB/점)** — 측정으로 확인.
- [docs] 문제정의·범위(PROBLEM) + 경쟁전략·계단식 목표(STRATEGY) + prior art 갭 검증(REFERENCES). "오픈+Cesium+COPC" 조립품 부재 확정 (동명 GitHub repo는 코드 0줄 빈 스텁).
- [docs] ADR-001 — 결과물 = Cesium provider 플러그인(`fromUrl`), 아키텍처 A(COPC 옥트리를 동적 Cesium3DTileset으로, LOD는 Cesium 위임). 근거: 과제의 TIFFImageryProvider(COG) 유사 힌트 + 측정.
- [feat] Phase 2 스파이크 — 런타임 pnts→Cesium3DTileset 다리 확정(`src/pnts.ts`, `?spike`); Cesium은 content를 XHR로 요청 → **서비스워커**가 가로채 온디맨드 pnts 응답(`public/copc-sw.js`, `?spike2`/`?spike3`). 아키텍처 끝에서 끝까지 디리스킹.
- [docs] 학습 사이트(MkDocs Material) — learn/ 6장 + 친절 개요 랜딩 + mermaid 다이어그램. (참고: mini-sim study 스타일)
- [feat] Phase 2 본편 ① — 진짜 COPC 노드를 서비스워커 경로로 온디맨드 렌더(`?spike4`). SW가 페이지로 라우팅(MessageChannel)→페이지 copc.js 디코드. stale SW 제어권 race는 unregister 선행으로 수정.
- [feat] Phase 2 본편 ② — **옥트리 LOD 스트리밍 작동**(`?spike5`). `copc-core.openCopc/decodeNode` + `tileset.ts`(옥트리→region tileset 트리). Cesium SSE가 278노드 중 **24노드만** 선택→온디맨드 디코드(`tileLoad:24/fail:0`). "보는 만큼만"이 Cesium 주도로 실데이터에서 구현됨.
- [feat] **`CopcTileset.fromUrl()` 공개 API + 기본 데모**(`src/copc-tileset.ts`). spike5 로직을 라이브러리 형태로 추출(세션별 sid 라우팅). 기본 페이지가 변환 없이 LOD 스트리밍 데모(`tileLoad:5/fail:0`). 결과물이 ADR-001의 `fromUrl` 형태를 갖춤. 남음: Web Worker 디코드·캐시·options·README.
