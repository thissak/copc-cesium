# PROGRESS — CopcCesiumLab

> 페이즈 체크리스트. 상태가 바뀌면 한 줄씩 갱신.

## Phase 0 — 부팅 + 프로파일링 하네스 ✅
환경이 돌고, 디버깅 도구가 보인다는 것 자체를 증명.

- [x] Vite + CesiumJS + copc.js 의존성 설치 (Cesium 1.142 / copc 0.0.8 / Vite 8)
- [x] Cesium Viewer 부팅 (globe 렌더) — Playwright로 실브라우저 검증, 콘솔 에러 0
- [x] 디버그 오버레이 ON (`debugShowFramesPerSecond`)
- [x] `docs/PROFILING.md` 4축 진단 프로토콜 문서화
- [x] `npm run dev` / `npm run build` 동작 확인 (build+tsc 통과)

## Phase 1 — COPC 단순 로드 (baseline) 🔓 BP 조사 완료, 계획 대기
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

### baseline 구현 (계획 승인 후)
- [ ] 샘플 COPC 데이터 확보 (공개 데이터셋)
- [ ] 루트 노드 포인트 → Cesium에 렌더 (PointPrimitiveCollection 또는 Primitive)
- [ ] 좌표계 정합 (header.wkt → ECEF)
- [ ] 4축 중 어디가 먼저 터지는지 측정 → 기록

## Phase 2 — 스트리밍 / LOD 엔진 🔒
SSE 기반 옥트리 순회 + range 스트리밍 + 메모리 캐시. (핵심 난관·STOP 규칙)
설계 가설 검증: Cesium 3D Tiles 래핑 vs custom primitive.

- [ ] 계획 + 검증기준 작성 → 승인
- [ ] (계획 시 상세화)

## Phase 3 — 평가 / 입상 판정 🔒
대용량 실데이터에서 60fps / 메모리 / UX 측정 → 입상 가능성 데이터로 판정.

- [ ] (Phase 2 이후 정의)

---
범례: ⏳ 진행 · ✅ 완료 · 🔒 착수 전(선행 필요)
