# PROGRESS — CopcCesiumLab

> 페이즈 체크리스트. 상태가 바뀌면 한 줄씩 갱신.

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

## Phase 2 — COPC Provider 플러그인 (LOD 스트리밍) ⏳ 스파이크 PASS
**아키텍처 확정([ADR-001](adr/001-provider-plugin-architecture-A.md)): A안 = `CopcTileset.fromUrl()` 플러그인, COPC 옥트리를 동적 Cesium3DTileset으로 노출, LOD는 Cesium 위임.**

- [x] BP 조사: pnts 바이너리 스펙 + Cesium 동적 content
- [x] **스파이크① 다리 확정** — 런타임 pnts(data URI) → Cesium3DTileset `tileLoad:1/fail:0`, RTC_CENTER로 Autzen 정확. (`?spike`, `src/pnts.ts`)
- [x] **스파이크②③ 온디맨드 가로채기 확정** — Cesium은 XHR로 요청(진단) → **서비스워커**가 가로채 요청 시점 pnts 생성·응답 `tileLoad:1`. (`?spike2`/`?spike3`, `public/copc-sw.js`)
- → **아키텍처 끝까지 디리스킹 완료.** 남은 건 "알려진 조립":
- [x] **본편 ① 진짜 COPC via SW** — 진짜 Autzen 노드를 SW 경로로 온디맨드 렌더 (`?spike4`)
- [x] **본편 ② 옥트리 LOD 스트리밍** — 옥트리(278노드)→동적 tileset 트리, Cesium SSE가 **24노드만** 선택 요청→온디맨드 디코드 `tileLoad:24/fail:0` (`?spike5`, `src/tileset.ts`+`copc-core` openCopc/decodeNode). **핵심 동작 작동.**
- [ ] 본편 ③ 디코드를 Web Worker로 + LRU 캐시 + 컴팩트 버퍼
- [ ] 본편 ④ `CopcTileset.fromUrl` API + projFunc + 데모/문서

## Phase 3 — 평가 / 입상 판정 🔒
대용량 실데이터에서 60fps / 메모리 / UX 측정 → 입상 가능성 데이터로 판정.

- [ ] (Phase 2 이후 정의)

---
범례: ⏳ 진행 · ✅ 완료 · 🔒 착수 전(선행 필요)
