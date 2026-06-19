# PROGRESS — CopcCesiumLab

> 페이즈 체크리스트. 상태가 바뀌면 한 줄씩 갱신.
> 방향·입상 로드맵: [DIRECTION](DIRECTION.md) · 성능 경쟁지형: [STRATEGY](STRATEGY.md)

## Phase 0 — 부팅 + 프로파일링 하네스 ✅
환경이 돌고, 디버깅 도구가 보인다는 것 자체를 증명.

- [x] Vite + CesiumJS + copc.js 의존성 설치 (Cesium 1.142 / copc 0.0.8 / Vite 8)
- [x] Cesium Viewer 부팅 (globe 렌더) — Playwright로 실브라우저 검증, 콘솔 에러 0
- [x] 디버그 오버레이 ON (`debugShowFramesPerSecond`)
- [x] `docs/PROFILING.md` 4축 진단 프로토콜 문서화
- [x] `npm run dev` / `npm run build` 동작 확인 (build+tsc 통과)

## Phase 1 — COPC 단순 로드 (baseline) ✅ 완료 — 갭 실증 (C1·C2·C3 PASS)
한 COPC 파일의 루트 노드를 *나이브하게* 렌더. 첫 프로파일링 타깃 확보.

### BP 조사 결과 (2026-06-16)
- [x] **copc.js getter API** — `Getter.http(url)` **내장**. HTTP range fetcher 손코딩 불필요(①축 해결).
  - `Copc.create(url|getter)` → header/vlrs/info(cube·spacing·rootHierarchyPage·wkt CRS).
  - `Copc.loadHierarchyPage(url, page)` → `{nodes,pages}`, 노드키 `'d-x-y-z'`(루트 `'0-0-0-0'`).
  - `Copc.loadPointDataView(url, copc, node)` → View(`.dimensions`, `.getter('X'|'Z'|'Red'...)`). laz-perf(WASM)로 디코드(②축).
  - header.scale/offset 로 int→world, header.wkt 가 CRS(좌표계 정합 입력).
- [x] **prior art** — **Hobu(=COPC 창시자)의 Eptium**이 정확히 이걸 함: COPC를 브라우저에서
  on-the-fly로 **3D Tiles 변환**해 Cesium에 스트리밍(국가 규모). → **우리 설계 가설(3D Tiles 래핑) 검증됨.**
  - **단, Eptium은 상용(proprietary)** — 공개 repo 없음, eptium.com에서 무료 사용/번들 라이선스.
  - 읽을 수 있는 레퍼런스: `github.com/hobuinc/hobu.co` 의 `copc-viewer.html`, `moon.html`(NASA LOLA).
- **결론**: 오픈소스 빌딩블록(copc.js+laz-perf+Cesium)은 다 있으나, **재사용 가능한 오픈소스 COPC↔Cesium 통합 라이브러리는 부재** = 대회 과제의 갭이 실재. 연구 리스크 아님, 엔지니어링 문제.

### baseline = "갭 실증 데모" (범위·기준 확정 2026-06-16)
문제정의·범위: `docs/PROBLEM.md` · 이진 기준: `.claude-criteria.md`
> 목적: naive 직접 로드의 정확성(T0) + 성능 벽(4축 중 어느 축, 몇 점)을 측정해 보인다. **데모는 느려도 된다.**

- [x] 공개 COPC 데이터 확보 — autzen(77MB)/millsite/sofi, Range 206+CORS 검증 (`src/datasets.ts`)
- [x] copc.js `Getter.http` → 점 → Cesium native 렌더 (PointPrimitiveCollection, 브라우저 동작)
- [x] **georeferencing [C1] PASS** — headless verify: center **-123.069°, 44.056° = Autzen, Oregon** (소수점 4자리 일치)
- [x] **측정 재현 가능 [C3]** — `npm run verify` 헤드리스 하네스(Node, stdout JSON+PASS/FAIL). source/render 분리(`copc-core.ts`)
- [x] **임계 N 특정 [C2-1]** — 실 GPU: fps 1M(74)→2M(40)→4M(17), 인터랙티브 벽 ≈ **2~3M점** (`?bench`)
- [x] **지배 축 [C2-2]** — GPU 아님. `PointPrimitiveCollection` 점당 오버헤드: 메모리 **1KB/점**(4M=3.9GB), build 초선형, fps 선형감소. → Phase 2 = 컴팩트 버퍼 + LOD

> **디버깅 로그 (딸깍 아님의 증거):** AI 생성 georef가 실제 데이터에서 2회 무너짐 → 측정으로 근본원인 짚어 수정.
> ① `proj4`가 COMPD_CS(복합좌표계) 미지원 → 내부 PROJCS 추출 + 피트→미터 Z 보정. ② laz-perf WASM이 Vite에서 미서빙(HTML 반환) → web 빌드 + `?url` 주입.

## Phase 2 — COPC Provider 플러그인 (LOD 스트리밍) ⏳ 본편 + 상용 코어 hardening 작동 (Step 0~3 ✅·리뷰됨, 측정·마감 남음)
**아키텍처 확정([ADR-001](adr/001-provider-plugin-architecture-A.md)): A안 = `CopcTileset.fromUrl()` 플러그인, COPC 옥트리를 동적 Cesium3DTileset으로 노출, LOD는 Cesium 위임.**

- [x] BP 조사: pnts 바이너리 스펙 + Cesium 동적 content
- [x] **스파이크① 다리 확정** — 런타임 pnts(data URI) → Cesium3DTileset `tileLoad:1/fail:0`, RTC_CENTER로 Autzen 정확. (`?spike`, `src/pnts.ts`)
- [x] **스파이크②③ 온디맨드 가로채기 확정** — Cesium은 XHR로 요청(진단) → **서비스워커**가 가로채 요청 시점 pnts 생성·응답 `tileLoad:1`. (`?spike2`/`?spike3`, `public/copc-sw.js`)
- → **아키텍처 끝까지 디리스킹 완료.** 남은 건 "알려진 조립":
- [x] **본편 ① 진짜 COPC via SW** — 진짜 Autzen 노드를 SW 경로로 온디맨드 렌더 (`?spike4`)
- [x] **본편 ② 옥트리 LOD 스트리밍** — 옥트리(278노드)→동적 tileset 트리, Cesium SSE가 **24노드만** 선택 요청→온디맨드 디코드 `tileLoad:24/fail:0` (`?spike5`, `src/tileset.ts`+`copc-core` openCopc/decodeNode). **핵심 동작 작동.**
- [x] **본편 ④(코어) `CopcTileset.fromUrl()` 공개 API + 기본 데모** — spike5 로직을 라이브러리로 추출(`src/copc-tileset.ts`). 기본 페이지가 변환 없이 LOD 스트리밍 (`tileLoad:5/fail:0`)
- [x] **본편 ③-A 성능** — 디코드를 **Web Worker(comlink)로 이동** + **POSITION_QUANTIZED**(uint16×3, 위치 바이트 절반) 컴팩트 버퍼. 기본 데모 `tileLoad:10/fail:0`, ECEF는 Cesium 대비 1.4e-9m 일치. (`src/decode.worker.ts`, `src/pnts-quantized.ts`, C1~C6 PASS)
- [x] **상용 코어 Step 0 생명주기/destroy** — 워커 `close` + per-session `destroy` + idle 시 worker terminate·SW 리스너 제거(누수 차단). (`copc-tileset.ts`)
- [x] **상용 코어 Step 1 하이어라키 페이징** — 서브페이지 온디맨드 로드(외부 tileset proxy) → GB 옥트리 임의 깊이 스트리밍(정확성 TOP 갭; millsite 141·sofi 111 서브페이지 더 이상 안 잘림). ([ADR-003](adr/003-hierarchy-subpage-paging.md))
- [x] **상용 코어 Step 2 복원력** — range 재시도(`p-retry`)+타임아웃 + 조용한 실패 제거(copc getter `response.ok` 미검사로 5xx→점데이터 둔갑 버그 수정). (`copc-core` httpGetterWithRetry, `scripts/check-retry.ts`)
- [x] **상용 코어 Step 3 속성 견고성** — `colorBy` 5모드(height/rgb/classification/intensity/returns) + 색 로직 `src/colors.ts` 통합. 차원 없으면 height 폴백+warn.
- [x] **Step 0~3 종합 적대적 리뷰**(Codex) — MUST-FIX 3건 수정(SW 백스톱 40s·`fromUrl` 초기화 실패 정리·잘못된 page 키 즉시 throw). build·verify·paging·retry·브라우저 PASS.
- [~] **본편 ③-B 측정 — 손코딩 primitive 기각([ADR-004](adr/004-delegate-memory-concurrency-to-cesium.md)).** ②예산·④eviction = Cesium `cacheBytes` 위임(실측: `tileUnload`로 SW-pnts evict·메모리 plateau), ③동시성 = 큐 타임아웃 → config 튜닝(워커풀 아님). **남음**: 노브값(maxReq·timeout·기본 cacheBytes) 실 GPU 측정. (서브페이지 노드 메타 누적은 별개 — `copcNodeCount()` 계측 훅 추가, cahokia 8.9GB 스트레스 예정)
- [~] 본편 ④(마감) **options 완료**(`pointSize`/`attenuation`/`eyeDomeLighting`/`colorBy` 5모드; `projFunc` 드롭) + **"부드럽게" ① 기본값 격파**(EDL·attenuation·colorBy 'rgb' 기본 on → 데모 product-grade). **남음**: README/라이선스 + 데모 페이지 다듬기
- [x] **깊은 옥트리(millsite) 렌더 정확성 — Potree 레퍼런스 대조로 2종 수정.** ① height 색 전역 Z 정규화(노드별 무지개 얼룩 제거, Potree `elevationRange` 방식) ② 노이즈 classification 필터(`hideClassifications` 기본 7·18 — 떠다니는 high-noise 13% 제거, sofi처럼 노이즈 없으면 무필터). 데모 훅 `?ds=`/`?maxReq=`. 검증: 헤드리스 44% 드롭·정합, sofi 교차확인, verify C1 PASS. (로컬 Potree `examples/copc.html` 대조)
- [ ] 실 GPU 대용량 검증 (사용자 머신) — `?soak`/`?bench`/`?perf` 하네스 준비됨; `?soak=millsite&secs=120`로 fps·메모리 천장·③빈도 확정 → ③-B 노브값 판정 게이트
  - [x] **렌더 파이프라인 병목 아님 확정** — `?perf` 3중 격리 + rAF 카운터로 30fps=환경 throttle(저전원·swiftshader) 판명, 추측 최적화 0.
  - [x] **지역단위 헤드리스 검증 (fema_pr 980MB 항공·cahokia 8.9GB MLS)** — georef 일치(푸에르토리코·일리노이), **노드 메타 누적 갭=누수 아님 확정**(Cahokia 90s soak `nodes` 2173→14352 **plateau**·heap~90MB/cesiumMB 12MB/tilesReady 58 plateau), eviction(cache=4MB→`unloads 0→7`), 회귀 0(verify·tsc). Cahokia 빈 영역=MLS 회랑 커버 본질(결함 아님). 기준 `.claude-criteria.md`. **남음(C4)**: 비-스로틀 실 GPU fps headline(`?perf=cahokia` 기본 캐시·전원연결)

### Eptium 경쟁지형 벤치 + LOD 보정 + IO 최적화 (2026-06-18, #01·#03 머지(PR#1) · #02 PR#2 · #04 fix/04)
- [x] **Eptium 벤치 오라클** — Playwright(실 GPU)+CDP로 우리 vs `viewer.copc.io` 대칭 측정(`npm run bench:eptium -- --ds millsite`). `docs/bench/FINDINGS.md`. handoff: `docs/handoff/eptium-bench-handoff.md`.
- [x] **[#01] under-refine 수정 — geometricError `spacing`→`cube_size/16`(ept-tools).** 동일 msse=8에서 루트 1타일(40k)→79타일(728k), autzen 61k→1.46M. (`src/tileset.ts`)
- [x] **[#03] 빈 노드(0점) Model PROCESSING 영구 고착 → `tilesLoaded` 무한대기 수정 — Cesium `missingTilePolicy`(404→`Empty3DTileContent`).** ([[no-silent-failures]] 정합) (`decode.worker.ts`+`copc-tileset.ts`+`copc-sw.js`, 이슈 #03)
- [x] **벤치 settle 메트릭 수정** — `numberOfTilesProcessing===0` 게이트가 SW-backed 타일셋서 영구 고착(거짓 25s) → `pending===0 && tilesReady 안정`으로 교체(#03이 근본원인). (`scripts/compare-eptium.ts`)
- [x] **매칭 점수 공정 비교 — 북극성 베이스라인(millsite, 실 GPU).** 렌더 점수 ±10% 매칭(ours msse=8 712k ↔ eptium msse=14 757k): 부드러움 동률(p50 8.3ms·120fps·hitch 0), 메모리 ours ~2× 우위(73.6 vs 144MB), 로드는 #02 해결로 Eptium 동급. (`docs/bench/FINDINGS.md` §v4)
- [x] **[#02] deep-load 속도 — range coalescing 으로 round-trip 61→6·settle 13.9s→4.8s(Eptium 동급).** 진단: deep-load 시간 ~99%가 per-node range TTFB(HTTP/1.1 S3 ~6연결 천장, 디코드 아님). 레버=round-trip 수 → 인접 노드 point-data를 연속 1 range로 병합·캐시(`createCoalescingGetter` two-cap + region-LRU, decode 경로 무변경). 골든파일 byte-identical·pointsSelected 712,458 불변. ([ADR-006](adr/006-range-coalescing.md), `src/copc-core.ts`, 이슈 #02)
- [x] **[#04] coalescing in-flight/rebuild 레이스 수정 — 잘린 슬라이스→laz-perf WASM 폭증(#02 잠복 회귀).** 무거운 sofi(1.9GB) msse=4서 발견: in-flight dedup이 `run.start`만 키잉 → 서브페이지 로드로 run 확장 시 옛 작은 region을 새 offset으로 슬라이스 → 빈 바이트→laz-perf 1.87GB alloc→abort. 수정(Arrow `ReadRangeCache` 패턴): in-flight를 fetch 정체성 `{start,end,bytes}`로 슬라이스 + 커버리지 미달 시 `base` 폴백. RED→GREEN(heap 1877MB→7MB 고정·완주), 이득 보존(round-trip 10 불변), 회귀 0(신규 Task7 레이스 단위·골든파일·build·verify·repro-03). ([이슈 #04](issues/04-lazperf-wasm-2gb-ceiling.md), `src/copc-core.ts` `createCoalescingGetter`, [[coalescing-inflight-race]] 위키)

### CRS 자동배치 견고화 (Tier1 #2, 2026-06-19 · feat/crs-auto-placement)
- [x] **no-WKT/파싱실패 silent 지구밖 → fail-loud + `crs`/`defaultCrs` override + center sanity 가드.** 측정으로 갭 확정: WKT happy path(WKT1·WKT2 모두 proj4 2.20.9 처리)는 견고, 진짜 갭=no-WKT(copc.js `.wkt` undefined→x,y를 경위도로→지구밖)·proj4 silent NaN. BP 조사(proj4/copc.js 설치버전 실측+prior-art 6종 py3dtiles·PDAL·giro3d·Potree·loaders.gl·Cesium) 합의=fail-loud+override(PDAL force/fill 2-mode)+axis/center sanity+geoid scope-out. 수정(A안): `resolveCrs`(crs>wkt>defaultCrs+try/catch)+`checkCenterInRange`(cube 중심 reproject 범위/NaN)로 인라인 georef 3지점 통합, 옵션 `fromUrl`→페이지·워커 세션. WKT2 무작업·per-point 배치 무변경(ECEF sub-mm). check-crs 10/10·autzen C1 회귀 0·ecef·hierarchy·coalesce·tsc·build PASS(AC1~7). 한계: EPSG override는 proj4 내장분·GeoTIFF GeoKey 자동복구=B안 follow-up·geoid 미보정(업계 norm). (IMPROVEMENTS #2 ✅, spec/plan `docs/superpowers/`)

### OSS 리팩토링 Stage 1 — 데모/lib 분리 (2026-06-19 · chore/oss-refactor-stage1)
- [x] **데모 하네스 `demo/` 분리 + 스파이크 프루닝.** `src/`=순수 라이브러리 9파일, 스파이크 7모드 프루닝(기본+`?naive`/`?bench`/`?perf`/`?soak`), `pnts`/`spike-batch` 삭제. dist byte-identical·verify·check-* 회귀 0. (Stage 2=copc-core 모듈 분할·Stage 3=영문화 심사 후)

## Phase 3 — 평가 / 입상 판정 🔒
대용량 실데이터에서 60fps / 메모리 / UX 측정 → 입상 가능성 데이터로 판정.

- [ ] (Phase 2 이후 정의)

---
범례: ⏳ 진행 · ✅ 완료 · 🔒 착수 전(선행 필요)
