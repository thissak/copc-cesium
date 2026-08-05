# IMPROVEMENTS — 개선 백로그 (증거 기반 우선순위)

> Codex 발견 + 코드 검증 + 커뮤니티 리서치(2026-06-18, 5개 소스 1차증거)를 통합한 우선순위 백로그.
> 방향은 [DIRECTION](DIRECTION.md) · 진행은 [PROGRESS](PROGRESS.md) · 결정은 [ADR](adr/). 이 문서는 *무엇을·왜 그 순서로* 개선하는가.
> 평가축: **실해 · 복잡도 · 우리-영역성(오픈 ∩ Cesium ∩ 무변환) · 입상 레버리지.**

## 시장 증거 (빈칸이 유료로 팔린다)

COPC 창시자 Hobu의 상용 **Eptium**이 *"COPC, COG, EPT data support for Cesium"*을 **$5,000~$25,000**(+연 $1k~5k)로 가격표화하고 *"Eptium is not open source"* 명시 — https://hobu.co/eptium.html. 동시에 **OSS 대체 전무**: `@loaders.gl/copc`는 tracker 개설 2년 뒤에도 npm 미출시(loaders.gl#2911), CesiumGS/cesium 이슈에 "COPC" **0건**, Cesium 포럼 표준답변 = *"COPC can not be loaded directly… you have to add some custom code"*(community.cesium.com/t/…/41643). → 우리가 채우는 빈칸이 *유료로 팔릴 만큼* 실재.

---

## Tier 1 — 입상 헤드라인 (우리만 풀 수 있는 + 실제 고통 + 데모 가능)

### 1. 속성·해상도 충실도 (attribute & resolution fidelity) ⭐ — **✅ 출하 (main 머지 2026-06-18, [ADR-005])**
- **출하**: `attributes` 옵션(큐레이션 기본|`'all'`|`string[]`) → pnts BATCH_TABLE+BATCH_ID → Cesium 동적 스타일링(`${Attr}`)·피킹(`getProperty`) + `rampStyle`/`attributeRange` 헬퍼. 실 브라우저 검증(autzen Classification 스타일·피킹·120fps). 제약: `${COLOR}` 폴백은 Model 경로서 미작동 → 구체색. (extra-bytes 정밀 타입은 FLOAT 폴백·테스트파일 부재로 YAGNI.)
- **실해**: 3D Tiles 변환이 per-point 속성(GPS-time·return number·scan angle·extra-bytes)과 정밀도/해상도를 **소리없이 드롭**한다. Ion 타일러는 Intensity+Classification만 살림.
- **우리-영역성**: COPC는 전체 LAS 속성 + native 정밀도를 보존 → **무변환이라 구조적으로 우리만 해결**. OSS 미해결(COPC를 스트리밍하는 giro3d조차 extra-bytes를 0으로 로드).
- **복잡도**: 높음 — copc.js dimension → typed buffer → GPU 를 zeroing/정밀도 손실 없이.
- **레버리지**: 최고 — 미답변 스레드 2018~2026, before/after 데모 명료, 우리 `colorBy`의 자연 심화.
- **증거**: cesium#46399(2026 미답변)·cesium#23087·gis.se#294307(2018 미답변·724뷰)·**giro3d#633**(extra-bytes=0, open)·WebODM classification 소실(community.opendronemap.org/…/19005).

### 2. CRS 자동 배치 (ECEF auto-placement) ⭐ — **✅ 출하 (A안, feat/crs-auto-placement 2026-06-19)**
- **출하**: WKT 자동 reproject(WKT1·WKT2 모두 proj4가 처리)는 happy path = zero-config. no-WKT/파싱실패/축뒤집힘 → **fail-loud**(`resolveCrs`) + `crs`(force)/`defaultCrs`(fill-if-missing) override(PDAL 2-mode) + cube 중심 sanity 가드(`checkCenterInRange`). geoid scope-out(heights=ellipsoidal, 업계 norm). **한계**: EPSG override는 proj4 내장분만, GeoTIFF GeoKey 자동복구·풀 EPSG 레지스트리 = B안 follow-up. (BP: proj4/copc.js 실측+prior-art 6종 · check-crs 10/10·AC1~7 · [ADR-007 예정])
- **실해**: 변환 후 포인트클라우드가 **지구 밖/거울상/수 m 오프셋**. Cesium은 ECEF(EPSG:4978)인데 원본 포인트클라우드는 거의 아님.
- **우리-영역성**: COPC/LAS WKT VLR 읽어 on-the-fly reproject → **zero-config** 배치.
- **복잡도**: bounded-hard(개념 해결, 운영 footgun).
- **레버리지**: 매우 높음 — **py3dtiles maintainer가 전용 FAQ를 유지**할 만큼 빈발("This issue is so common"). 가장 즉각 "그냥 된다" 데모.
- **증거**: SO#79257450(py3dtiles maintainer)·gis.se#481090(907뷰 "black space, mirror image")·SO#69606114(1.8m offset)·giro3d#665(옥트리도 변환 필요).

### 3. 옥트리 피킹 / 최근접점 / 스냅 (picking) — stretch — **#3-A ✅·#3-B ✅ 출하**
- **#3-A ✅**(2026-06-20, PR#7): 클릭→점 정보 조회 `pickPoint()`.
- **#3-B ✅**(2026-06-23, PR#21; PR#28 metric 보강): 옥트리 풀해상도 최근접점 스냅 `tileset.snapPoint()` — 가장 깊은 노드 디코드→실제 최근접 점. projected 혼합단위와 geographic ECEF metric 지원. **한계**: 로컬 노드 내 최근접(전역 보장 아님·경계 ~0.14m·이웃검색=후속). renderer-shaped 리스크는 스냅=데이터쿼리라 미발생. 측정 도구(거리/면적)·시각화=후속.
- **실해**: Cesium pick이 포인트클라우드에서 globe로 빠짐·최근접점 검색 없음·측정 스냅 안 됨.
- **우리-영역성**: COPC 옥트리 = 공간 인덱스 → `.pnts` tileset엔 없는 구조적 우위로 pick API 한계 돌파.
- **복잡도**: 진짜 hard + 부분적으로 renderer-shaped(리스크↑).
- **레버리지**: 높음 — 측량·AEC 유료 도메인, Cesium 포럼 최다 hard 클러스터. **단 web-voiced(picking/snap)만**, clipping/cross-section은 desktop-voiced·Potree有 → 제외.
- **증거**: cesium#9870·cesium#41868·cesium#8955.

## Tier 2 — 완성도/견고성 (실해 있음 · 헤드라인 아님 · 해야 함)

### 4. 취소 / 백프레셔 전파 (Codex #2) — **WON'T-FIX (이슈 #20, 2026-06-23)**
- **결론**: measure-first 로 착수했으나 **Phase 0 게이트 FAIL** — 우리 SW-인터셉트 아키텍처에서 취소 신호의 유일 진입점인 SW `event.request.signal` 이 클라이언트 abort 시 **미발화**(실측, w3c/ServiceWorker #1544). 클린 수정 불가(fragile Cesium-내부 monkey-patch 만 가능). 실해 측정서도 in-flight 디코드 ≤2·self-heal(유계). Tier2 비헤드라인 → won't-fix. 상세 [이슈 #20](issues/20-cancel-backpressure-propagation.md).
- **코드 확정 완성도 갭**: Cesium이 XHR 취소(`cancelFunction`→`xhr.abort()`)해도 SW(`copc-sw.js`)가 `e.request.signal`을 안 보고(보려 해도 미발화), worker `decode()`에 abort 인자 없음, copc-core fetch는 내부 8s 타임아웃만 → 불필요해진 타일의 fetch/decode가 끝까지 돌아 워커 점유.
- **커뮤니티 corroborate**: giro3d#677 "cancel-in-flight" critical.
- **재개 조건**: Cesium 이 SW-가시 취소 채널 제공 시, 또는 헤드 실GPU서 새-영역 지속 churn 의 무계 누적·실 UX 저하 실증 시 → 비-취소 완화책(워커 큐 유계화→503 재요청) 재검토.

### 5. CORS / range 정직성 + small-range 약속
- S3 403/206 불일치·`Range: bytes=0-`로 전체 받는 함정(giro3d#636). 명확 에러 + "COPC 올바로 호스팅" 문서.
- **증거**: gis.se#484038(206 불일치)·gis.se#468088(S3 Forbidden, 미답변).

### 6. laz-perf CSP / 호스팅 스토리
- Emscripten 출력의 `eval()`/`Function`이 CSP `default-src 'self'`에서 차단(giro3d#561, "upstream"). WASM 호스팅/CSP 가이드.

### 7. Point budget — 깊은 줌 부드러움 유계화 (이슈 #08) — **✅ 완료 (2026-06-20, `feat/fair-engine-bench`)**
- **출하**: `pointBudget` 옵션(기본 200만) → Cesium 네이티브 `cacheBytes = maximumCacheOverflowBytes = pointBudget × 8B`(점당 실측 ~16B)로 근사 캡 — **손코딩 0**(`memoryAdjustedScreenSpaceError`가 한도 초과 시 refine 자동 억제, ADR-001 위임). measure-first 게이트로 동적 SSE 외부루프 불필요 확정(Circuit Breaker).
- **검증(실 GPU M4 Pro, 2시점×on/off, `scripts/bench/probe-budget.ts`)**: 깊은 줌 9.29M/16fps → **2.10M/89fps**, 정상뷰 7.0M → 2.06M, **양 시점 스크린샷 시각 동일**(여분점=sub-pixel noise). 환산 ±5%. tsc·verify 회귀 0. measure-first가 전제 2개 적발(sub-pixel 가정은 EDL on서도 참 / "정상뷰 무영향" 거짓이나 품질 OK).
- **코드 확정 갭(해결 전)**: ours 표준 SSE refine은 점 상한 없음 → 깊은 줌 무제한(10M+)·GPU-bound. Eptium은 764k 고정 점예산.
- **판정**: 북극성 **"부드럽게"** 직결 — Eptium parity라 헤드라인 차별화는 약하나(Tier 2) 완성도 필수. 상세 `docs/issues/08-point-budget.md` §3~5 · handoff.

## Tier 3 — 이미 강점 / commodity (유지·튜닝만, 차별화로 안 밂)
- LOD/메모리/point budget → Cesium 위임 **상속**([ADR-001]). EDL/attenuation → Cesium 네이티브(3DTilesRendererJS보다 앞섬, #912). 동시성 → 방금 출하(`maxRequestsPerServer`, [ADR-004]). colorBy 5모드 → 이미 있음(**Tier1-#1이 이걸 심화**).

## 낮음 / 버림
- **Codex #1 hierarchy 메타 eviction** — 측정상 경량 plateau·실해 없음 → **YAGNI**(Cahokia 8.9GB 90s soak heap ~90MB plateau).
- 웹 clipping/cross-section(desktop-voiced·Potree有) · EPT-vs-COPC 논쟁(사용자 미호소) · filter-before-fetch/predicate pushdown(진짜 미래 차별화지만 giro3d#622, 지금 스코프 X).

---

## 추천 순서

**Tier1 #1(속성 충실도) → #2(CRS 자동배치)** 묶음이 입상 서사:
> *"당신의 COPC를 **있는 그대로** 읽는다 — 전체 속성·전체 정밀도·지구 위 정확히, 변환 0."*

현재 **어떤 OSS도 못 하는** 일관된 이야기. #1 = hard + demoable + 구조적 우리것, #2 = 최고 ROI 첫인상. #4 취소는 완성도로 별도 트랙.

## 리서치 한계 (정직)
Reddit 검색 불가(r/gis·r/lidar 미샘플) · rpls/laserscanningforum 403(스니펫만) · COPC가 SO/SE에 직접 거의 없음(빈칸이지만 organic 발견도 낮음→능동 evangelism 필요).
