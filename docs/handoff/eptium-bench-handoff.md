# Eptium 벤치 오라클 + LOD 수정 Handoff

> 작성 2026-06-18 · 브랜치 `worktree-eptium-bench` (origin/main 기준 fresh) · 미머지
> 이 세션: "Eptium과 숫자로 성능비교" → 벤치 구축 → 객관 측정 → 실재 결함 1건 수정(#01) + 1건 진단(#02).

## 완료된 작업

### 1. Eptium 벤치 오라클 (하니스)
- `scripts/compare-eptium.ts` + `scripts/bench/{probe,report,types,selftest}.ts`. Playwright(headed=실 GPU)+CDP로 우리 `localhost:5173` 와 Eptium(`viewer.copc.io/?copc=<url>`)을 **`window.viewer` 대칭 구동**.
- 양쪽 다 CesiumJS `Cesium3DTileset.statistics` 노출 → 동일 카메라·동일 msse에서 같은 내부지표 비교.
- 데이터셋: `--ds autzen|millsite|sofi`. 실행: `npm run bench:eptium -- --ds millsite --msse 8`(prebench 훅이 probe 번들 esbuild 재생성).
- probe는 IIFE 번들(`scripts/bench/probe-bundle.js`, gitignored, prebench 재생성)로 `addInitScript` 주입 — tsx/esbuild `__name` footgun 우회.
- 설계/계획: `docs/superpowers/specs/2026-06-18-eptium-bench-oracle-design.md`, `docs/superpowers/plans/2026-06-18-eptium-bench-oracle.md`.

### 2. 측정 결론 (`docs/bench/FINDINGS.md`)
- **autzen**: 둘 다 vsync 천장(120fps·hitch 0) — 규모가 작아 구분 안 됨.
- **millsite(실 GPU)**: 같은 msse=8·같은 octree에서 우리=루트 1타일(40k점), Eptium=109타일(1.49M점) **37×** → under-refine 발견.

### 3. 이슈 #01 — under-refine **수정·검증 완료** (`docs/issues/01-...`)
- 원인: `src/tileset.ts` geometricError base가 `spacing`(=cube/147)이라 ept-tools 표준(cube/16)보다 **9.2× 과소** → 같은 msse에 거의 refine 안 함.
- 수정(4줄): base를 `(s.cube[3]-s.cube[0])*zUnit/16`로. (ept-tools=Entwine/Eptium 혈통)
- 검증(실 GPU): millsite 40k→728k(타일 1→79), autzen 61k→1.46M, `npm run build` PASS.

### 4. 이슈 #02 — deep-load 느림 **진단(워커풀 기각)** (`docs/issues/02-...`)
- 가설(단일 디코드 워커 직렬화) → 워커풀 구현 → A/B(`?pool=1` vs `6`) 측정 → **동일(966k/12s)** → 디코드 병목 아님 → **revert**(코드 무변경).
- 진짜 병목 = **HTTP/1.1 S3 ~6 동시연결(네트워크 IO)**. throttle 6은 ADR-004 의도값(>6이면 S3 타임아웃·재시도 폭풍).

## 다음 작업 (우선순위)

0. ~~**벤치 settle 메트릭 수정**~~ ✅ **완료 (2026-06-18, 이 handoff 이후 세션)** — `settleFullRes`에서 `processing===0` 게이트 제거(`pending===0 && tilesReady 안정`). 진단으로 원인 확정: `numberOfTilesProcessing`이 **13에 영구 고착**(0으로 안 떨어짐)이라 settle 영영 미판정→거짓 25s. 재측정 millsite msse=8 TTD 25s→16.4s. 신규 진단 하니스 `scripts/bench/diag-settle.ts`. 부수발견(고착 원인)은 **이슈 #03**으로 분리. (`scripts/compare-eptium.ts`, `docs/issues/03-tiles-processing-stuck.md`)
1. ~~**이슈 #03 — processing 13 영구 고착 근본원인**~~ ✅ **완료 (2026-06-18)** — 원인=빈 노드(전부 노이즈 7/18 → 0점)가 빈 pnts로 서빙돼 Cesium `Model3DTileContent`(0점)가 PROCESSING 영구 고착 → `tilesLoaded`/`allTilesLoaded` 무한대기(가설 A 확정). 수정=빈 노드를 404→Cesium `missingTilePolicy`→`Empty3DTileContent`(ready)로. 검증 RED→GREEN(proc 13→0)·회귀 0·점수 712k 유지. 재현/회귀 하니스 `scripts/bench/repro-03.ts`. 상세 `docs/issues/03-tiles-processing-stuck.md`.
2. **이슈 #02 깊은 IO 프로파일** — 같은 S3·같은 ~6연결인데 Eptium ~2.3× 빠름(15 vs 6.5 타일/s). DevTools Performance로 우리 **SW 파이프라인 per-tile 레이턴시**(Cesium→SW→page→worker→S3→역경로) 측정. Eptium의 fetch 청크 크기/HTTP-2·CDN 여부 조사(네트워크 탭). 가설: SW 왕복 오버헤드 또는 요청 효율.
3. ~~**매칭 점수 재벤치**~~ ✅ **완료 (2026-06-18)** — 점수 ±10% 맞춘 공정 비교(ours msse8 712k ↔ eptium msse14 757k): 부드러움 동률(120fps·hitch0), 메모리 ours ~2× 우위(73.6 vs 144MB), 로드 Eptium ~4× 빠름(3.8 vs 16s, deep-load IO=#02). scout=`match-sweep.ts`, bench per-target msse. 상세 `docs/bench/FINDINGS.md` §v4.
4. **브랜치 정리 + 머지** — 아래 "히스토리 주의" squash, CHANGELOG/PROGRESS는 이 세션에서 갱신됨, PR. (CLAUDE.md 빌드섹션에 `bench:eptium` 추가는 머지 시.)

## 알려진 이슈

- ~~**벤치 settle 메트릭 결함**~~ ✅ 수정됨(`processing===0` 게이트 제거) — 근본원인(processing 13 고착)은 이슈 #03으로 추적 중.
- **1a 축 비대칭(autzen/millsite 리포트의 TTD·bytes·heap 무효)** — 우리 네트워크는 SW/Worker 경유라 페이지 CDP에 안 잡힘(bytes 헤더만), framing(bsRadius) 차이. 유효 비교는 frametime(부드러움)·렌더 점수뿐. FINDINGS에 명시됨.
- **히스토리 잡음** — 자동 Stop-훅 리뷰 게이트(`rev-t1` 팀메이트)가 감독 없이 만든 커밋(`f96834a`·`561c863`)과 중복 메시지 커밋(`1313ff6`/`756a810`)이 섞임. 머지 전 squash 권장. (rev-t1은 stand-down됨.)
- **`?pool=N` 노브 없음** — #02 revert로 제거됨. 재측정 필요시 재추가.

## 핵심 결정 사항

- **geometricError = `cube_size/16 / 2^depth`** (ept-tools 관례). spacing 기반 폐기. [issue #01]
- **워커풀 기각** — deep-load 병목은 디코드가 아니라 네트워크 IO(측정). 단일 워커 유지. [issue #02]
- **throttle 6 유지** — ADR-004 의도값(HTTP/1.1 S3). 단순 상향은 위험.
- **측정 신뢰모델 2-tier** — 재현 가능 파이프라인 지표가 1급, 실 GPU fps는 2급. 헤드리스 fps(swiftshader) 무효.
