# Stage 1 — 데모/랩 ↔ 라이브러리 분리 (OSS 리팩토링)

<!-- created: 2026-06-19 -->
<!-- topic: oss-refactor-stage1-demo-library-separation -->

## 배경 / 목표

성능이 상용(Eptium) 동급에 도달한 시점에서, repo 를 오픈소스 공개에 맞게 정리한다.
이는 3-stage 분해의 첫 조각이다:

- **Stage 1 (이 스펙)** — 데모/랩 코드와 출하 라이브러리를 물리적으로 분리.
- Stage 2 (별도 사이클) — `copc-core.ts`(508) 모듈 분할.
- Stage 3 (심사 후) — 주석 한국어→영문화 + 기여자 문서.
- 별도 — API/SW 진입장벽 완화 (리팩토링 아닌 설계 작업, 이번 범위 밖).

**목표**: 외부인이 repo 를 열었을 때 `src/` 가 911줄 데모 하네스가 아니라 순수 출하
라이브러리(9 파일)로 보이게 한다. 출하물(`dist/`)은 **byte-identical** 로 보존한다.

## 비목표 (Non-goals)

- 라이브러리 동작/공개 API 변경 — 없음.
- `dist/` 출하물 변경 — 없음 (byte-identical 이 게이트).
- `src/copc-core.ts` 등 코어 분할 — Stage 2.
- 주석 영문화 — Stage 3 (한국인 심사 후).
- 역사 기록(PROGRESS/CHANGELOG/ADR/handoff/superpowers 기존 specs) 재작성 — 하지 않음.

## 결정 — 스파이크 잔재 프루닝

디리스킹 스파이크(`?spike`~`?spike5`, `?spikeBatch`, `?spikeReal`)는 아키텍처가
증명된 지금 순수 잔재이며 git 히스토리 + `docs/arch` 학습트랙 + ADR 에 서사로 보존돼 있다.
"오픈소스에 맞게"의 핵심이 외부인에게 깔끔한 데모를 보이는 것이므로, 9개 모드 중 7개가
vestigial 인 상태는 노이즈다 → **이동과 동시에 프루닝**한다.

근거: 스파이크는 Phase 2 디리스킹 산출물로 라이브러리에 흡수됨. 재실행 가치 0, git+docs 보존.
대조군 데모(`?bench`/`?naive` = naive 벽 vs 스트리밍)는 대회 내러티브 가치가 있어 **유지**한다.

## 타깃 레이아웃

```
src/          ← 순수 출하 라이브러리 (변경 없음, import 도 무변경)
  index.ts, copc-tileset.ts, copc-core.ts, decode.worker.ts,
  pnts-quantized.ts, colors.ts, attributes.ts, copc-style.ts, tileset.ts
demo/         ← 랩/데모 하네스 (이동)
  main.ts      (스파이크 함수·라우팅 프루닝)
  copc.ts      (loadCopcNaive/getLazPerf — naive·bench 가 사용)
  datasets.ts  (DATASETS — perf·soak·bench·naive 가 사용)
scripts/      ← 변경 없음 (../src/ 경로 그대로 유효)
index.html    ← <script src> 한 줄만 /demo/main.ts 로
```

## 파일 단위 액션

| 파일 | 액션 | 비고 |
|------|------|------|
| `src/main.ts` | `demo/main.ts` 로 이동 + 프루닝 | 스파이크 함수(`runSpike*`)·`?spike*`/`?spikeBatch`/`?spikeReal` 라우팅 제거 |
| `src/copc.ts` | `demo/copc.ts` 로 이동 | `loadCopcNaive`·`getLazPerf` 유지(bench/naive 사용) |
| `src/datasets.ts` | `demo/datasets.ts` 로 이동 | |
| `src/pnts.ts` | **삭제** | `buildPnts`/`toBase64` 는 스파이크 전용 → 프루닝 후 dead |
| `src/spike-batch.ts` | **삭제** | `?spikeBatch`/`?spikeReal` 전용 → dead |
| `index.html` | 편집 | `src="/src/main.ts"` → `src="/demo/main.ts"` |
| `CLAUDE.md` | 편집 | "브라우저:" 줄에서 `?spike`~`?spike5` 제거, 생존 모드(bench/naive/perf/soak) 반영 |

### import 리라이트 규칙 (`demo/` 이동 파일)

- 라이브러리 참조: `./copc-core` → `../src/copc-core`, `./tileset` → `../src/tileset`,
  `./copc-tileset` → `../src/copc-tileset` 등.
- 동반 이동한 데모 파일끼리: `./copc`, `./datasets` 상대경로 유지.
- 프루닝 후 unused 가 되는 import 제거: `main.ts` 의 `getLazPerf`(line 467, spike5),
  `buildTileset`(line 511, spike5), `buildPnts`/`toBase64`(spikes). `src/tileset.ts` 자체는
  라이브러리이므로 **유지**.

## 빌드 / 설정 영향

- `tsup`(build:lib): 엔트리 = `src/index.ts`+`src/decode.worker.ts`. 데모와 독립 → **dist byte-identical**.
- `vite build`(데모→demo-dist): 엔트리 = 루트 `index.html`. `vite.config.ts` 무변경.
- `tsc --noEmit`: 이동 파일이 리라이트된 import 로 타입체크 통과해야 함.
- `scripts/`: `../src/` 만 참조 → 영향 0.

## 검증 기준 (Acceptance Criteria)

- [ ] **AC1**: `npm run build:lib` 후 `dist/` 가 변경 전과 **byte-identical** (`git stash` 기준 또는 사전 해시 대조, diff 0).
- [ ] **AC2**: `npm run build` (tsc --noEmit + vite) — 타입에러 0, demo-dist 산출.
- [ ] **AC3**: `npm run dev` 실브라우저 — 기본 데모(`CopcTileset.fromUrl`)가 점군 LOD 스트리밍 렌더, 콘솔 에러 0.
- [ ] **AC4**: `npm run verify` — C1 Oregon(-123.069°, 44.056°) PASS.
- [ ] **AC5**: `scripts/check-*` 전부 통과 (최소 `check-ecef`·`check-coalesce`·`check-attributes` 회귀 0).
- [ ] **AC6**: `src/` 에 데모/스파이크 파일 부재 (main/copc/datasets/pnts/spike-batch 없음), `demo/` 에 main/copc/datasets 존재, pnts/spike-batch 삭제됨.
- [ ] **AC7**: 생존 데모 모드 동작 — `?naive`·`?bench`·`?perf`·`?soak` 진입 시 에러 없이 라우팅(스모크).
- [ ] **AC8**: 프루닝된 모드(`?spike`..`?spike5`/`?spikeBatch`/`?spikeReal`) 진입 시 기본 데모로 폴백(죽은 분기 없음, 콘솔 에러 0).

## 테스트 시나리오

- **정상**: `?` 없는 기본 URL → `runDemo()` → 점군 렌더 (AC3).
- **정상**: `?perf=millsite&secs=10` → perf 하네스 진입·`window.__perf` 산출 (AC7).
- **엣지**: `?spike5`(제거된 모드) → 분기 없으니 `runDemo()` 폴백, 콘솔 에러 0 (AC8).
- **실패**: tsc 가 unused import(`buildTileset`/`getLazPerf`) 잔존 시 에러 → 제거로 GREEN (AC2).
- **회귀**: `dist/` 해시 변동 = FAIL (AC1) — 출하물 오염 즉시 검출.

## 롤백

순수 파일 이동 + 라우팅 삭제라 `git revert` 한 번으로 완전 가역. 출하물 무영향이라
배포 리스크 0. 스파이크 코드는 git 히스토리에 영구 보존.
