# Phase 2 (COPC Provider 스트리밍) Handoff

갱신 2026-06-17. 핵심 기능 + 공개 API 작동. **다음 = 상용 코어 hardening** (돌기만 → 상용 퀄리티; 입상 목표).

## 완료된 작업
- 아키텍처: [ADR-001](../adr/001-provider-plugin-architecture-A.md)(결과물=`CopcTileset.fromUrl()`, A안) + [ADR-002](../adr/002-service-worker-tile-interception.md)(서비스워커 가로채기 + 페이지 디코드 라우팅)
- 스파이크 ①②③: 런타임 pnts→Cesium 로드 / Cesium은 XHR 요청 / 서비스워커 온디맨드 가로채기 ([RESULTS](../RESULTS.md))
- **본편 ① 진짜 COPC via SW** (`?spike4`) — 진짜 Autzen 노드를 SW 경로로 온디맨드 렌더
- **본편 ② 옥트리 LOD 스트리밍** (`?spike5`) — 옥트리(278노드)→동적 tileset 트리, Cesium SSE가 24노드만 선택 (`tileLoad:24/fail:0`)
- **본편 ④코어 `CopcTileset.fromUrl()` 공개 API** (`src/copc-tileset.ts`) + 기본 데모 페이지
- 타일 LOD 경계 단차: boundingVolume 높이를 데이터 Z로 조여 완화
- 코드 맵: `copc-core.ts`(openCopc/decodeNode) · `tileset.ts`(옥트리→tileset) · `copc-tileset.ts`(공개 API) · `pnts.ts`(pnts 생성) · `public/copc-sw.js`(SW)
- 검증: `npm run verify`/`sweep`, `?bench`(fps), `?spike`~`?spike5`, 기본=데모

## 완료 (Phase 2 코어 + 옵션)
- **③-A 성능(2026-06-17)** — `comlink` 단일 워커 디코드 + `POSITION_QUANTIZED`(점당 15→9B). `src/decode.worker.ts`·`src/pnts-quantized.ts`, C1~C6 PASS.
- **④ options(2026-06-17)** — `pointSize`/`attenuation`/`eyeDomeLighting`/`colorBy('height'|'rgb')`. `projFunc`는 드롭(워커 per-point IPC 마비; prior art는 직렬화 CRS 문자열 — ADR-001 §4 정정). 오버라이드는 `sourceCrs` 문자열/워커-사이드 팩토리로 후속.

## 다음 작업 — 상용 코어 hardening (입상 직결, "부수"는 후순위)
목표: 돌기만 하는 라이브러리가 아니라 **핵심 코어가 상용 퀄리티** — 국가 규모 GB COPC를 정확·고속·안정적으로. README·데모·fps 같은 포장은 뒤로.

### Step 0 — 선정리 ✅ 완료(2026-06-17)
- **생명주기/destroy 소유권**: 워커 `close(sid)` + tileset `destroy()` 확장(=`scene.primitives.remove()` 경유 자동 호출)로 세션 정리. `activeSids` 추적 → 마지막 세션이면 `worker.terminate()` + SW 리스너 제거(누수 차단). 디코드 라우팅 `decodeTile(sid,key)` 단일 seam 캡슐화. wrapper 없음. C1~C6 PASS(SW-서빙 200/500으로 결정 판정). (Codex #1·#3)
  - **주의(사용법)**: 정리는 `viewer.scene.primitives.remove(tileset)` 또는 `removeAll()` 경유가 정석. `tileset.destroy()`를 씬에서 빼지 않고 직접 부르면 Cesium이 파괴된 객체를 렌더하다 크래시(Cesium 표준 동작).

### Step 1+ — 상용 갭 (STOP 영역 → 갭 감사: 실측 + BP → 계획·검증기준 승인 후 착수)
1. ~~**하이어라키 페이징 (정확성·치명·TOP)**~~ ✅ **완료(2026-06-17)** — `openCopc`가 `pages` 보관, `pages[key]` 노드에 외부 tileset proxy 자식(`page/{key}.json`); SW→페이지 `loadSubPage`+`buildSubtree` 온디맨드, 워커 `loadPage`. 외부 tileset 방식(implicit tiling 미사용). 측정: millsite 141·sofi 111 서브페이지가 더 이상 안 잘림. 검증: Node(88노드·23k점) + 브라우저 millsite(`.pnts` 500→200). `scripts/check-paging.ts`. C1~C6 PASS.
2. **워커 풀**: 단일 → 바운드 풀(`navigator.hardwareConcurrency`, `workerpool`). **디코드 큐잉 실측 후.**
3. **LRU + 메모리 상한**: 디코드 타일 캐시(`lru-cache`) + **하이어라키 노드 캐시 상한**. **재디코드 빈도·노드 누적 실측 후.** Cesium `cacheBytes` 중복 주의. (현재 깊은 항해 시 `session.nodes` 단조 증가 — 아래 알려진 이슈)
4. ~~**속성 견고성**~~ ✅ **완료(2026-06-17)** — `colorBy`: height/rgb/classification(ASPRS)/intensity/returns. 색 로직 `src/colors.ts` 단일 통합(Codex #4, `pnts-quantized` 는 양자화+패킹만). 차원 없으면 height 폴백+warn. 검증: Autzen 5/5 distinct, millsite rgb→폴백. C1~C6 PASS.
5. ~~**복원력**~~ ✅ **완료(2026-06-17)** — `httpGetterWithRetry`(copc-core): status 검사(copc 의 5xx→점데이터 둔갑 조용한실패 수정)+ `p-retry` 지수백오프(네트워크·429·5xx 재시도, 4xx·416 즉시중단)+ fetch `AbortSignal.timeout(8s)` + SW 왕복 `race(15s)`. `scripts/check-retry.ts` 8케이스 PASS. 조용한 실패 제거(`void close`→`.catch(log)` 등). 제외: 서킷브레이커·코얼레싱.

### 부수 (후순위)
- README/라이선스 · 데모 다듬기(옵션 토글) · 실 GPU 대용량 fps 측정(병행 가능 — ③-A 끊김↓·단차 정량 확인 겸).

## 알려진 이슈 / 주의
- 디코드 세션이 워커·페이지 양쪽에 1개씩(각자 `openCopc`) → 헤더+옥트리 fetch 2회(1회성·경량). 페이지 세션은 디코드 안 함(WASM 불필요)
- 양자화 정밀도는 per-tile QUANTIZED_VOLUME(타일 ECEF extent)에 상대 → 도시 스케일 cm~mm. 전역 단일 볼륨 쓰면 정밀도 붕괴(주의)
- **stale SW 제어권 race**: `register` 전 unregister 또는 `reg.update()` + controllerchange 대기
- Cesium은 content를 XHR로 가져옴 → 가로채기는 fetch 패치 ❌, **서비스워커 필수**
- 정밀도: pnts에 **RTC_CENTER 필수**. CRS는 proj4 (COMPD_CS는 PROJCS 추출 + 단위보정, `copc-core.ts`)
- 인접 타일 LOD 단차: 일부는 octree LOD 본질 특성(attenuation/EDL로 *가림*), 일부는 bbox 헐거움(조임으로 완화)
- ~~누수: worker `sessions`·SW 리스너·worker 싱글톤 해제 경로 없음~~ **해결(Step 0)**: `primitives.remove`/`destroy` 시 per-session close + idle 시 worker terminate·리스너 제거
- **깊은/장시간 항해 시 메모리 증가(미해결)**: `loadSubPage` 가 방문 노드를 페이지·워커 세션에 누적·축출 없음(destroy 까지). GB 데이터 장시간 항해 주의 → LRU(Step1+ ③, 측정 후)로 상한. 정직히 노출(종합 리뷰 #3)
- **SW 백스톱 40s**: 워커 재시도 예산(~34s)보다 길게 — 느린-회복 읽기를 죽이지 않게 정렬됨(종합 리뷰 #1)
- 대회 범위: 버전 유지보수(허들#5) OUT, 실데이터 동물원(#4) 완화. correctness 안 깎음

## 코드 리뷰 (Codex, SOLID·anti-over-eng, 2026-06-17)
- **선정리 1건만 필수**: Step 0(생명주기/destroy). 나머지 구조 변경은 *그 기능 할 때 lazy*하게 — 지금 추상화 금지.
- **건드리지 말 seam(이미 좋음)**: 순수 core↔Cesium 레이어 분리(`copc-core`↔`copc.ts`) · 워커의 Cesium-free 경계 · 작은 `CopcTilesetOptions` · 순수변환 `buildTileset` · 격리된 `extractHorizontalCrs`.
- **over-eng watch**: `copc-sw.js`의 스파이크 합성경로(`/__copc/`)는 스파이크 제거 시 같이 정리 · `pnts.ts`(float32)/`pnts-quantized.ts` 병존은 데모·스파이크가 float32 쓰는 동안만 허용(상용 코어선 중복).

### Step 0~3 종합 적대적 리뷰 (Codex, 2026-06-17) — 수정 완료
- MUST-FIX 3건 수정: SW 백스톱 40s·`fromUrl` 초기화 실패 정리(`releaseSession`)·`buildPageTileset` 잘못된 키 즉시 throw. colorBy 폴백은 세션당 1회 경고로 디노이즈(throw 반박). 무한 누적은 문서화(위). 검증: build·verify·paging·retry·브라우저(초기화실패→정상복구) PASS.
- 남은 over-eng watch: `/__copc/` 스파이크 경로 제거 시 정리(현재 ?spike2/3 가 사용).
- **결론**: 견고한 프로토타입 기반. Step 0(per-session destroy 배선)이 누수도 줄이고 워커풀·LRU의 가장 좁은 seam도 동시에 연다 = 최고 레버리지.

## 핵심 결정
- 비교 기준점 = 오픈 동료(Giro3D/Potree), Eptium 아님
- STOP 규칙: ③ 착수 전 계획 + 검증기준 승인
