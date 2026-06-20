# Stage 1 — 데모/랩 ↔ 라이브러리 분리 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 데모/랩 코드를 `demo/`로 분리하고 디리스킹 스파이크를 프루닝해, `src/`를 순수 출하 라이브러리로 만든다 — 출하물(`dist/`)은 byte-identical 보존.

**Architecture:** 순수 파일 이동(`git mv`) + import 경로 리라이트 + 죽은 스파이크 코드 삭제. 라이브러리 코어(`src/` 9파일)는 한 줄도 안 건드린다. 검증은 `dist/` byte-identical(AC1) + 기존 헤드리스 하네스(verify/check-*)로 게이트.

**Tech Stack:** TypeScript(strict), Vite(데모 빌드), tsup(라이브러리 빌드), tsx(check 스크립트), Playwright(브라우저 스모크).

## Global Constraints

- `dist/` 출하물 **byte-identical** — `build:lib` 결과 5파일(`index.js`/`index.d.ts`/`decode.worker.js`/`copc-sw.js`/`laz-perf.wasm`) 해시 불변. (AC1, 하드 게이트)
- 신규 의존성 **0**. 라이브러리 공개 API·동작 **무변경**.
- `src/` 9파일(`index`/`copc-tileset`/`copc-core`/`decode.worker`/`pnts-quantized`/`colors`/`attributes`/`copc-style`/`tileset`)의 내용·import **무변경**.
- 역사 기록(`docs/PROGRESS.md`·`docs/CHANGELOG.md`·`docs/adr/`·`docs/handoff/`·기존 `docs/superpowers/specs|plans`) **재작성 금지** — append-only.
- 파일 이동은 `git mv`로 — rename 히스토리 보존.

---

### Task 1: 데모 파일 이동 + import 리라이트 (프루닝 없음)

데모 5파일을 `demo/`로 옮기고 import를 고쳐 **9개 모드 전부 동작**하는 GREEN 상태를 만든다. "이동이 무언가를 깨뜨렸나"를 프루닝과 분리해 검증한다.

**Files:**
- Create(이동): `demo/main.ts` (← `src/main.ts`), `demo/copc.ts` (← `src/copc.ts`), `demo/datasets.ts` (← `src/datasets.ts`), `demo/pnts.ts` (← `src/pnts.ts`), `demo/spike-batch.ts` (← `src/spike-batch.ts`)
- Modify: `index.html` (script src), `tsconfig.json` (include)
- Unchanged: `src/` 전부, `vite.config.ts`, `tsup.config.ts`, `scripts/`

**Interfaces:**
- Consumes: 없음 (첫 태스크)
- Produces: `demo/main.ts`가 데모 엔트리. `demo/{copc,datasets,pnts,spike-batch}.ts`가 데모 전용 모듈. `src/`는 라이브러리 표면으로 고정.

- [ ] **Step 1: dist byte-identical 베이스라인 캡처 (AC1 오라클)**

이동 전 현재 src로 라이브러리를 빌드하고 해시를 기록한다. (src는 이 태스크에서 안 바뀌므로 이 해시가 최종 기대값.)

Run:
```bash
npm run build:lib && (cd dist && shasum -a 256 index.js index.d.ts decode.worker.js copc-sw.js laz-perf.wasm | tee /tmp/dist-baseline.sha256)
```
Expected: 5개 파일 해시 출력, `/tmp/dist-baseline.sha256` 저장. tsup 에러 0.

- [ ] **Step 2: `demo/`로 파일 이동 (`git mv`)**

Run:
```bash
mkdir -p demo && git mv src/main.ts demo/main.ts && git mv src/copc.ts demo/copc.ts && git mv src/datasets.ts demo/datasets.ts && git mv src/pnts.ts demo/pnts.ts && git mv src/spike-batch.ts demo/spike-batch.ts
```
Expected: 5파일 `demo/`로 이동, rename으로 스테이징.

- [ ] **Step 3: `demo/main.ts`의 라이브러리 import를 `../src/`로 리라이트**

`demo/main.ts` 상단 import 블록 — 라이브러리 참조만 `./` → `../src/`로 바꾼다. 동반 이동한 데모 모듈(`./copc`/`./datasets`/`./pnts`)은 그대로.

변경 전(현 line 16–21):
```ts
import { loadCopcNaive, getLazPerf } from './copc';
import { openCopc, decodeNode } from './copc-core';
import { buildTileset } from './tileset';
import { DATASETS } from './datasets';
import { buildPnts, toBase64 } from './pnts';
import { CopcTileset } from './copc-tileset';
```
변경 후:
```ts
import { loadCopcNaive, getLazPerf } from './copc';
import { openCopc, decodeNode } from '../src/copc-core';
import { buildTileset } from '../src/tileset';
import { DATASETS } from './datasets';
import { buildPnts, toBase64 } from './pnts';
import { CopcTileset } from '../src/copc-tileset';
```

- [ ] **Step 4: `demo/copc.ts`의 라이브러리 import를 `../src/`로 리라이트**

`demo/copc.ts`는 `import { loadCopcPoints } from './copc-core'` 한 곳을 고친다(나머지 `cesium`/`laz-perf` import는 node_modules라 무변경).

변경 전:
```ts
import { loadCopcPoints } from './copc-core';
```
변경 후:
```ts
import { loadCopcPoints } from '../src/copc-core';
```

- [ ] **Step 5: `demo/spike-batch.ts`의 라이브러리 import를 `../src/`로 리라이트**

`demo/spike-batch.ts`가 `./`로 참조하는 라이브러리 모듈(예: `./copc-tileset`/`./copc-style`/`./attributes` 등 실제 존재하는 것)을 전부 `../src/`로 바꾼다. 확인:
```bash
grep -n "from '\./" demo/spike-batch.ts
```
나오는 각 `from './X'`를 `from '../src/X'`로 (단 `demo/`에 함께 있는 모듈이면 그대로 둔다 — spike-batch는 라이브러리만 참조하므로 전부 `../src/`가 됨).

- [ ] **Step 6: `index.html` 엔트리 경로 갱신**

변경 전:
```html
    <script type="module" src="/src/main.ts"></script>
```
변경 후:
```html
    <script type="module" src="/demo/main.ts"></script>
```

- [ ] **Step 7: `tsconfig.json` include에 `demo` 추가 (타입체크 커버리지 보존)**

데모가 `src/` 밖으로 나가면 현재 `"include": ["src"]`로는 tsc가 데모를 검사하지 않는다. `demo`를 추가해 기존 커버리지 유지.

변경 전:
```json
  "include": ["src"]
```
변경 후:
```json
  "include": ["src", "demo"]
```

- [ ] **Step 8: 타입체크 + 데모 빌드 (이동 검증)**

Run: `npm run build`
Expected: `tsc --noEmit` 타입에러 0 + vite가 `demo-dist/` 산출. (이 시점엔 스파이크 함수가 살아있어 `buildPnts`/`getLazPerf`/`buildTileset` 전부 사용 중 → unused 에러 없음.)

- [ ] **Step 9: dist byte-identical 확인 (AC1)**

Run:
```bash
npm run build:lib && (cd dist && shasum -a 256 -c /tmp/dist-baseline.sha256)
```
Expected: 5파일 모두 `OK`. (src 무변경이므로 라이브러리 번들 불변.)

- [ ] **Step 10: 헤드리스 정확성 회귀 (AC4)**

Run: `npm run verify`
Expected: C1 PASS — center ≈ `-123.069°, 44.056°` (Autzen, Oregon), stdout JSON + PASS.

- [ ] **Step 11: 브라우저 스모크 — 기본 데모 (AC3)**

`npm run dev`를 백그라운드로 띄우고 Playwright로 `http://localhost:5173` 접속 → 캔버스 렌더 + 콘솔 에러 0 확인.
Expected: 포인트클라우드 LOD 스트리밍 렌더, `pageerror`/`console.error` 0. 확인 후 dev 서버 종료.

- [ ] **Step 12: 커밋**

```bash
git add -A
git commit -m "refactor(oss): 데모/랩 코드를 demo/로 분리 — src=순수 라이브러리 (프루닝 전)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: 스파이크 프루닝 + 죽은 파일 삭제 + unused import 제거

디리스킹 스파이크 모드/함수를 제거하고 `demo/pnts.ts`·`demo/spike-batch.ts`를 삭제한다. tsc `noUnusedLocals`가 남은 unused import를 자동 적발한다.

**Files:**
- Modify: `demo/main.ts` (스파이크 함수·라우팅·import 제거), `CLAUDE.md` (브라우저 모드 줄)
- Delete: `demo/pnts.ts`, `demo/spike-batch.ts`
- Unchanged: `src/` 전부, `demo/copc.ts`, `demo/datasets.ts`

**Interfaces:**
- Consumes: Task 1의 `demo/main.ts`(9모드).
- Produces: 4모드 데모(`runDemo` 기본 + `?naive`/`?bench`/`?perf`/`?soak`). 제거 모드는 `else { runDemo() }`로 폴백.

- [ ] **Step 1: 라우팅에서 스파이크 분기 제거**

`demo/main.ts` 끝의 라우팅 if/else 체인에서 `spike5`/`spike4`/`spike3`/`spike2`/`spike`/`spikeReal`/`spikeBatch` 분기를 삭제한다. `bench`/`soak`/`perf`/`naive`/`else(runDemo)`만 남긴다.

변경 후 라우팅(이것만 남아야 함):
```ts
if (params.has('bench')) {
  const custom = params.get('bench');
  // …(기존 bench 본문 유지)…
} else if (params.has('soak')) {
  runSoak();
} else if (params.has('perf')) {
  runPerf();
} else if (params.has('naive')) {
  run(); // Phase 1 naive baseline (참고용)
} else {
  runDemo(); // 기본 = 공개 API 데모
}
```
(각 분기 본문은 기존 코드 유지 — 함수 호출명은 현 파일 그대로.)

- [ ] **Step 2: 스파이크 함수 정의 제거**

`demo/main.ts`에서 스파이크 전용 함수 정의를 삭제한다 — `?spike`~`?spike5`가 호출하던 함수들(`runSpike`/`spike2`/`spike3`/`spike4`/`spike5` 계열, 각 함수가 `window.__spikeN`을 세팅하는 블록). `runDemo`·`run`(naive)·`runBench`·`runSoak`·`runPerf`·`runGlobePerf`는 **유지**한다. 식별:
```bash
grep -n "^async function\|^function\|window.__spike" demo/main.ts
```
`__spike`/`__spike2`…`__spike5`를 세팅하는 함수들이 삭제 대상.

- [ ] **Step 3: 죽은 데모 파일 삭제**

Run:
```bash
git rm demo/pnts.ts demo/spike-batch.ts
```
Expected: 두 파일 삭제 스테이징. (`pnts.ts`=`buildPnts`/`toBase64`는 스파이크 전용, `spike-batch.ts`=`?spikeBatch`/`?spikeReal` 전용 → 모두 dead.)

- [ ] **Step 4: tsc로 unused import 적발 → 제거**

Run: `npm run build`
Expected(1차): tsc가 `noUnusedLocals` 위반 나열 — 최소 `demo/main.ts`의 `buildPnts`, `toBase64`(`./pnts` — 이제 없음), `getLazPerf`(`./copc`), `buildTileset`(`../src/tileset`). 이들은 스파이크에서만 쓰였음.

tsc가 가리키는 각 심볼을 import에서 제거한다. 최종 import 블록(데드 제거 후):
```ts
import { loadCopcNaive } from './copc';
import { openCopc, decodeNode } from '../src/copc-core';
import { DATASETS } from './datasets';
import { CopcTileset } from '../src/copc-tileset';
```
주의: `loadCopcNaive`는 `?naive`/`?bench`가 쓰므로 **유지**. `openCopc`/`decodeNode`가 남은 모드(perf/soak)에서 쓰이는지 tsc가 판정 — unused로 잡히면 함께 제거.

- [ ] **Step 5: 타입체크 + 데모 빌드 GREEN (AC2)**

Run: `npm run build`
Expected(2차): 타입에러 0, `demo-dist/` 산출. (unused 전부 제거 후 GREEN.)

- [ ] **Step 6: `CLAUDE.md` 브라우저 모드 줄 갱신**

`CLAUDE.md`의 "브라우저:" 줄에서 제거된 모드를 빼고 생존 모드를 반영한다.

변경 전:
```
브라우저: 기본 = `CopcTileset.fromUrl` 데모 · `?bench`(fps) · `?spike`~`?spike5`(스파이크) · `?naive`(Phase1 baseline).
```
변경 후:
```
브라우저: 기본 = `CopcTileset.fromUrl` 데모 · `?naive`(Phase1 baseline) · `?bench`(fps 벽) · `?perf`/`?soak`(스트리밍 측정). 데모/랩 코드는 `demo/`.
```

- [ ] **Step 7: dist byte-identical 재확인 (AC1)**

Run:
```bash
npm run build:lib && (cd dist && shasum -a 256 -c /tmp/dist-baseline.sha256)
```
Expected: 5파일 `OK`. (프루닝은 demo만 건드림.)

- [ ] **Step 8: 정확성 회귀 (AC4)**

Run: `npm run verify`
Expected: C1 Oregon PASS.

- [ ] **Step 9: 브라우저 스모크 — 생존 모드 + 폴백 (AC7·AC8)**

`npm run dev` 백그라운드 + Playwright로:
- `http://localhost:5173/?perf=autzen&secs=5` → perf 진입, 콘솔 에러 0 (AC7).
- `http://localhost:5173/?spike5` → 제거된 모드 → `runDemo()` 폴백, 포인트클라우드 렌더, 콘솔 에러 0 (AC8, 죽은 분기 없음).
Expected: 둘 다 `pageerror` 0. 확인 후 dev 종료.

- [ ] **Step 10: 커밋**

```bash
git add -A
git commit -m "refactor(oss): 디리스킹 스파이크 프루닝 — pnts/spike-batch 삭제, 데모 9→4모드

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: 전체 회귀 스윕 + 문서 갱신

라이브러리 회귀가 없음을 check 스크립트 전체로 확정하고, 프로젝트 컨벤션대로 CHANGELOG/PROGRESS를 갱신한다.

**Files:**
- Modify: `docs/CHANGELOG.md` (최상단 항목 추가), `docs/PROGRESS.md` (Stage 1 완료 줄)
- Unchanged: 코드 전부

**Interfaces:**
- Consumes: Task 2 결과(4모드 데모, src=라이브러리).
- Produces: 없음 (문서/검증 마감).

- [ ] **Step 1: check 스크립트 전체 회귀 (AC5)**

Run:
```bash
npx tsx scripts/check-ecef.ts && npx tsx scripts/check-coalesce.ts && npx tsx scripts/check-attributes.ts && npx tsx scripts/check-crs.ts
```
Expected: 전부 PASS (ECEF Cesium 일치, coalesce 레이스 단위 GREEN, attributes 차원 노출, crs 10/10). 라이브러리 무변경이므로 회귀 0.

- [ ] **Step 2: 최종 dist byte-identical 종단 확인 (AC1)**

Run:
```bash
rm -rf dist && npm run build:lib && (cd dist && shasum -a 256 -c /tmp/dist-baseline.sha256)
```
Expected: clean 빌드 후에도 5파일 `OK`.

- [ ] **Step 3: `src/`·`demo/` 구조 확정 (AC6)**

Run:
```bash
ls src/ | sort && echo "---" && ls demo/ | sort
```
Expected: `src/` = `attributes.ts copc-core.ts copc-style.ts copc-tileset.ts colors.ts decode.worker.ts index.ts pnts-quantized.ts tileset.ts` (9파일, 데모/스파이크 부재). `demo/` = `copc.ts datasets.ts main.ts` (pnts/spike-batch 삭제됨).

- [ ] **Step 4: `docs/CHANGELOG.md` 항목 추가**

`### 2026-06-19` 섹션 최상단에 추가:
```
- [refactor] **[OSS Stage 1] 데모/랩 ↔ 라이브러리 분리 + 스파이크 프루닝.** 데모 하네스(`main`/`copc`/`datasets`)를 `demo/`로 이동, `src/`를 순수 출하 라이브러리 9파일로 고정. 디리스킹 스파이크(`?spike`~`?spike5`/`?spikeBatch`/`?spikeReal`) 프루닝 → `pnts.ts`·`spike-batch.ts` 삭제(git+docs/arch에 서사 보존), 데모 모드 9→4(기본/`?naive`/`?bench`/`?perf`/`?soak`). tsconfig `include`에 `demo` 추가(타입체크 커버리지 보존). **출하물 byte-identical**(dist 5파일 해시 불변·AC1), verify C1·check-*(ecef/coalesce/attributes/crs)·build·build:lib 회귀 0. 신규 의존성 0·공개 API 무변경. (spec/plan `docs/superpowers/`, Stage 2=copc-core 분할·Stage 3=영문화는 별도)
```

- [ ] **Step 5: `docs/PROGRESS.md` Stage 1 완료 표기**

`### CRS 자동배치 견고화` 섹션 다음에 한 줄 추가(또는 적절한 위치):
```
### OSS 리팩토링 Stage 1 — 데모/lib 분리 (2026-06-19 · chore/oss-refactor-stage1)
- [x] **데모 하네스 `demo/` 분리 + 스파이크 프루닝.** `src/`=순수 라이브러리 9파일, 데모 9→4모드, `pnts`/`spike-batch` 삭제. dist byte-identical·verify·check-* 회귀 0. (Stage 2=copc-core 모듈 분할·Stage 3=영문화 심사 후)
```

- [ ] **Step 6: 커밋**

```bash
git add docs/CHANGELOG.md docs/PROGRESS.md
git commit -m "docs(refactor): OSS Stage 1 분리 완료 — CHANGELOG/PROGRESS 갱신

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review (작성자 점검 완료)

**1. Spec coverage:**
- AC1(dist byte-identical) → T1 S9, T2 S7, T3 S2 ✓
- AC2(build tsc+vite) → T1 S8, T2 S5 ✓
- AC3(dev 기본 데모) → T1 S11 ✓
- AC4(verify C1) → T1 S10, T2 S8 ✓
- AC5(check-*) → T3 S1 ✓
- AC6(src/demo 구조) → T3 S3 ✓
- AC7(생존 모드) → T2 S9 ✓
- AC8(프루닝 모드 폴백) → T2 S9 ✓
- 스펙 파일 액션(이동/삭제/프루닝/index.html/CLAUDE.md) → T1·T2 전부 매핑 ✓
- **스펙 갭 보완**: tsconfig `include` 추가(T1 S7) — 스펙 미기재였으나 타입체크 커버리지 보존에 필수.

**2. Placeholder scan:** "기존 bench 본문 유지"/"기존 코드 유지"는 placeholder가 아니라 *유지(무변경)* 지시 — 변경 대상이 아닌 코드를 그대로 두라는 명시. 삭제/추가 코드는 전부 verbatim 제시. ✓

**3. Type consistency:** import 심볼명(`loadCopcNaive`/`openCopc`/`decodeNode`/`DATASETS`/`CopcTileset`/`buildTileset`/`getLazPerf`/`buildPnts`/`toBase64`)은 Task 1 grep 실측과 일치. 경로 리라이트 규칙 일관(`./libX`→`../src/libX`, 동반 데모 모듈은 `./` 유지). ✓
