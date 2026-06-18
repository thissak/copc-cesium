# CRS 자동배치 견고화 (Tier1 #2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** COPC의 CRS를 WKT로 자동 배치하되, WKT 부재·파싱실패·축뒤집힘 시 조용한 오배치(지구 밖/NaN/거울상) 대신 명확히 throw하고 `crs`/`defaultCrs` 옵션으로 우회하게 한다.

**Architecture:** georef를 `resolveCrs`(우선순위 해소 + proj4 생성 try/catch)와 `checkCenterInRange`(reproject 결과 sanity 가드) 두 순수 함수로 추출해 `src/copc-core.ts`의 3개 인라인 지점(`loadCopcPoints`·`openCopc`·decodeNode 경유)이 공유한다. 세션을 여는 2곳(페이지=`copc-tileset.ts`, 워커=`decode.worker.ts`)은 `crs`/`defaultCrs`를 `openCopc`로 전달한다. per-point 배치(`geodeticToEcef`)와 디코드는 무변경.

**Tech Stack:** TypeScript strict, `proj4@2.20.9`, `copc@0.0.8`, tsx(Node headless 테스트), Vite/tsc.

## Global Constraints

- TypeScript strict. 기존 파일 스타일 따름. 변경 라인은 요청에 직결(주변 코드 "개선" 금지).
- 조용한 실패 금지 — 모든 CRS 실패는 throw로 표면화([[no-silent-failures]]).
- proj4 입력 1급 = proj4 string / WKT. EPSG 코드는 proj4 내장분(WGS84·UTM zones·3857)만 best-effort; 미등록 EPSG는 명확 에러.
- geoid/vertical datum 보정 안 함(업계 norm) — 문서화만.
- WKT2는 작업 대상 아님(proj4 2.20.9가 처리). `extractHorizontalCrs`의 WKT2 `COMPOUNDCRS` 미슬라이스는 알려진 한계로 둠.
- per-point 배치 아키텍처 무변경(검증됨, ECEF sub-mm 일치).
- 헤드리스 테스트 패턴: `tsx scripts/check-*.ts`, 성공 `process.exit(0)` + `PASS` 출력, 실패 `process.exit(1)`.

---

### Task 1: `resolveCrs` — CRS 우선순위 해소 + proj4 생성 가드

**Files:**
- Modify: `src/copc-core.ts` (`extractHorizontalCrs` 아래, 라인 ~170 부근에 추가; `Reproj` 타입은 라인 173에 이미 존재 — 그 위로 옮기거나 함수보다 먼저 선언되게)
- Test: `scripts/check-crs.ts` (신규)

**Interfaces:**
- Consumes: 기존 `extractHorizontalCrs(wkt: string): { proj: string; linearUnit: number }`, `proj4`, 기존 `type Reproj = { forward: (coord: number[]) => number[] }`.
- Produces:
  - `export type CrsOpts = { crs?: string; defaultCrs?: string }`
  - `export function resolveCrs(wkt: string | undefined, opts?: CrsOpts): { toWgs: Reproj; zUnit: number }` — 성공 시 `toWgs` 항상 정의; CRS 미해결/파싱실패 시 throw.

- [ ] **Step 1: Write the failing test**

`scripts/check-crs.ts` 생성:

```ts
// CRS 해소·가드 단위 테스트 (헤드리스, Node).
// 실행: npx tsx scripts/check-crs.ts
import { resolveCrs, checkCenterInRange } from '../src/copc-core';

let fails = 0;
function ok(cond: boolean, msg: string) {
  console.log(`${cond ? 'ok  ' : 'FAIL'}  ${msg}`);
  if (!cond) fails++;
}
function throws(fn: () => unknown, msg: string) {
  let threw = false;
  try { fn(); } catch { threw = true; }
  ok(threw, msg);
}

// 테스트용 정의 (proj4 string — 레지스트리 불필요)
const UTM10N = '+proj=utm +zone=10 +datum=WGS84 +units=m +no_defs'; // Autzen 권역
const UTM11N = '+proj=utm +zone=11 +datum=WGS84 +units=m +no_defs'; // 다른 zone

// --- resolveCrs ---
// no-CRS → throw (silent 지구밖 방지)
throws(() => resolveCrs(undefined, {}), 'no WKT + no override → throw');
throws(() => resolveCrs(undefined), 'no WKT + no opts → throw');

// header WKT 사용
{
  const { toWgs } = resolveCrs(UTM10N, {});
  const [lon] = toWgs.forward([500000, 4878000]);
  ok(lon > -124 && lon < -122, `header CRS used (lon=${lon.toFixed(3)})`);
}

// crs(force) 가 header 를 덮는다 — 같은 입력좌표가 다른 zone 으로 다른 lon
{
  const a = resolveCrs(UTM10N, {}).toWgs.forward([500000, 4878000])[0];
  const b = resolveCrs(UTM10N, { crs: UTM11N }).toWgs.forward([500000, 4878000])[0];
  ok(Math.abs(a - b) > 1, `crs override changes result (Δlon=${(a - b).toFixed(3)})`);
}

// defaultCrs = fill-if-missing: header 있으면 무시, 없으면 적용
{
  const headerWins = resolveCrs(UTM10N, { defaultCrs: UTM11N }).toWgs.forward([500000, 4878000])[0];
  const onlyDefault = resolveCrs(UTM10N, {}).toWgs.forward([500000, 4878000])[0];
  ok(Math.abs(headerWins - onlyDefault) < 1e-9, 'defaultCrs ignored when header present');
  const fill = resolveCrs(undefined, { defaultCrs: UTM11N }).toWgs.forward([500000, 4878000])[0];
  ok(Number.isFinite(fill), 'defaultCrs applied when header missing');
}

// 파싱 불가 def → throw (silent NaN 아님)
throws(() => resolveCrs('not a real crs definition', {}), 'garbage CRS → throw');

console.log(fails === 0 ? '\nCRS PASS ✅' : `\nCRS FAIL ❌ (${fails})`);
process.exit(fails === 0 ? 0 : 1);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx scripts/check-crs.ts`
Expected: FAIL — `resolveCrs`/`checkCenterInRange` 가 `copc-core` 에 export 안 됨 → import 에러로 즉시 종료(또는 `is not a function`).

- [ ] **Step 3: Write minimal implementation**

`src/copc-core.ts`에서 — 기존 `type Reproj = ...`(라인 173)를 `extractHorizontalCrs` 위(라인 144 이전)로 이동(아래 함수들이 참조). 그 다음 `extractHorizontalCrs` 바로 아래에 추가:

```ts
export type CrsOpts = { crs?: string; defaultCrs?: string };

/**
 * CRS 를 우선순위로 해소해 WGS84 변환을 만든다 (PDAL 2-mode).
 *   opts.crs(force) > wkt(header) > opts.defaultCrs(fill-if-missing) > 없음→throw.
 * proj4 입력은 proj4 string / WKT 1급, EPSG 코드는 proj4 내장분만. 파싱 불가/미해결은 throw(조용한 오배치 방지).
 */
export function resolveCrs(wkt: string | undefined, opts: CrsOpts = {}): { toWgs: Reproj; zUnit: number } {
  const def = opts.crs ?? wkt ?? opts.defaultCrs;
  if (!def) {
    throw new Error(
      'COPC has no embedded CRS (no WKT). Pass a CRS via the `crs` option ' +
        "(proj4 string / WKT / built-in EPSG), or `defaultCrs` to fill when the file omits one.",
    );
  }
  const horiz = extractHorizontalCrs(def);
  let toWgs: Reproj;
  try {
    toWgs = proj4(horiz.proj, proj4.WGS84) as unknown as Reproj;
    if (typeof toWgs.forward !== 'function') throw new Error('no forward()');
  } catch (e) {
    throw new Error(
      `CRS parse failed for "${String(def).slice(0, 60)}…" — pass a valid proj4 string or WKT ` +
        `via the \`crs\` option. (${(e as Error).message})`,
    );
  }
  return { toWgs, zUnit: horiz.linearUnit };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx scripts/check-crs.ts`
Expected: `checkCenterInRange` import는 아직 미정의라 import 단계에서 실패할 수 있음 → **Task 2에서 함께 GREEN**. 임시 확인: `checkCenterInRange` import 라인을 잠시 주석 처리하고 실행하면 `CRS PASS ✅`. (Task 2에서 주석 해제.)

> 주: Task 1·2는 같은 테스트 파일을 공유하므로 한 커밋으로 묶어도 좋다. 분리 시 위 임시 주석 처리로 Task 1을 독립 검증.

- [ ] **Step 5: Commit**

```bash
git add src/copc-core.ts scripts/check-crs.ts
git commit -m "feat(#2): resolveCrs — CRS 우선순위 해소(crs>wkt>defaultCrs) + proj4 생성 가드"
```

---

### Task 2: `checkCenterInRange` — reproject sanity 가드 (axis/mirror/garbage 백스톱)

**Files:**
- Modify: `src/copc-core.ts` (`resolveCrs` 아래)
- Test: `scripts/check-crs.ts` (Task 1 파일에 케이스 추가)

**Interfaces:**
- Consumes: `type Reproj`.
- Produces: `export function checkCenterInRange(toWgs: Reproj, cube: number[]): void` — cube([minx,miny,minz,maxx,maxy,maxz]) 중심을 1회 reproject, 결과가 유효 lon/lat 아니면 throw.

- [ ] **Step 1: Write the failing test**

`scripts/check-crs.ts`의 `process.exit` 직전에 추가(그리고 상단 import 의 `checkCenterInRange` 주석을 해제):

```ts
// --- checkCenterInRange ---
const UTM10N_cube = [490000, 4870000, 0, 510000, 4886000, 500]; // Autzen UTM10N 권역
{
  const { toWgs } = resolveCrs(UTM10N, {});
  let threw = false;
  try { checkCenterInRange(toWgs, UTM10N_cube); } catch { threw = true; }
  ok(!threw, 'in-range center passes');
}
// 잘못된 CRS(항등 WGS84 변환에 UTM 큰좌표 주입) → lon/lat 범위 밖 → throw
{
  const wgs84Identity = resolveCrs('+proj=longlat +datum=WGS84 +no_defs', {}).toWgs;
  throws(() => checkCenterInRange(wgs84Identity, UTM10N_cube), 'out-of-range center → throw');
}
// NaN 좌표(out-of-domain) → throw
{
  const nanReproj = { forward: () => [NaN, NaN] };
  throws(() => checkCenterInRange(nanReproj, UTM10N_cube), 'NaN reproject → throw');
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx scripts/check-crs.ts`
Expected: FAIL — `checkCenterInRange is not a function` (또는 import 에러).

- [ ] **Step 3: Write minimal implementation**

`src/copc-core.ts`에서 `resolveCrs` 아래에 추가:

```ts
/**
 * reproject 정합 가드: cube 중심을 1회 변환해 lon/lat 가 유효 범위인지 확인.
 * 범위 밖/NaN 이면 throw — 잘못된 CRS·축 뒤집힘(거울상)·out-of-domain 을 점 루프 진입 전 조기 차단.
 */
export function checkCenterInRange(toWgs: Reproj, cube: number[]): void {
  const cx = (cube[0] + cube[3]) / 2;
  const cy = (cube[1] + cube[4]) / 2;
  const [lon, lat] = toWgs.forward([cx, cy]);
  if (!(Number.isFinite(lon) && Number.isFinite(lat) && lon >= -180 && lon <= 180 && lat >= -90 && lat <= 90)) {
    throw new Error(
      `CRS reproject out of range (lon=${lon}, lat=${lat}) — likely wrong CRS or swapped axis order. ` +
        'Pass the correct CRS via the `crs` option.',
    );
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx scripts/check-crs.ts`
Expected: `CRS PASS ✅`, exit 0.

- [ ] **Step 5: Commit**

```bash
git add src/copc-core.ts scripts/check-crs.ts
git commit -m "feat(#2): checkCenterInRange — reproject 범위/축 sanity 가드(거울상·NaN 차단)"
```

---

### Task 3: 인라인 georef 3지점을 `resolveCrs`+`checkCenterInRange`로 교체

**Files:**
- Modify: `src/copc-core.ts`
  - `loadCopcPoints` 시그니처 + georef (라인 80-104)
  - `openCopc` 시그니처 + georef (라인 188-213)
- Test: `npm run verify` (autzen C1 회귀), `npx tsx scripts/check-crs.ts`

**Interfaces:**
- Consumes: `resolveCrs`, `checkCenterInRange`, `CrsOpts` (Task 1·2).
- Produces:
  - `loadCopcPoints(url, pointBudget, lazPerf?, crsOpts?: CrsOpts)` — 4번째 인자 추가(기본 `{}`).
  - `openCopc(url, opts?: { coalesce?: CoalesceOpts } & CrsOpts)` — 기존 opts에 `crs`/`defaultCrs` 합류.

- [ ] **Step 1: 회귀 기준 확인 (RED 아님 — 변경 전 GREEN 고정)**

Run: `npm run verify`
Expected: 기존대로 `C1 PASS ✅` (autzen center in Oregon). 이 값이 교체 후에도 불변이어야 한다.

- [ ] **Step 2: `loadCopcPoints` 교체**

`src/copc-core.ts` 라인 80-84 시그니처를:

```ts
export async function loadCopcPoints(
  url: string,
  pointBudget: number,
  lazPerf?: LazPerf,
  crsOpts: CrsOpts = {},
): Promise<CorePoints> {
```

라인 100-104(인라인 georef)를:

```ts
  // 좌표계: resolveCrs(crs>wkt>defaultCrs) → WGS84 변환. cube 중심 sanity 가드.
  const wkt = copc.wkt;
  const { toWgs, zUnit } = resolveCrs(wkt, crsOpts);
  checkCenterInRange(toWgs, copc.info.cube);
```

이후 점 루프(라인 119-129)의 `if (toWgs) { ... }` 분기는 `toWgs`가 항상 정의되므로 무조건 변환으로 단순화:

```ts
      const x = gx(i);
      const y = gy(i);
      const z = gz(i) * zUnit;
      const out = toWgs.forward([x, y]) as number[];
      lonLatH.push(out[0], out[1], z);
      zVals.push(z);
```

(반환문의 `crsWkt: wkt`는 유지.)

- [ ] **Step 3: `openCopc` 교체**

`src/copc-core.ts` 라인 188 시그니처를:

```ts
export async function openCopc(url: string, opts?: { coalesce?: CoalesceOpts } & CrsOpts): Promise<CopcSession> {
```

라인 192-193(인라인)을:

```ts
  const { toWgs, zUnit } = resolveCrs(copc.wkt, { crs: opts?.crs, defaultCrs: opts?.defaultCrs });
  checkCenterInRange(toWgs, copc.info.cube);
```

세션 객체(라인 194-203)의 `toWgs`·`zUnit` 필드를 위 값으로 설정(`zUnit: horiz ? ... : 1` → `zUnit`). `CopcSession.toWgs` 타입은 `Reproj | undefined`에서 `Reproj`로 좁혀도 되나, **최소 변경**으로 타입은 유지하고 값만 항상 정의되게 둔다(decodeNode의 `if (s.toWgs)`는 항상 true로 동작, 무변경).

- [ ] **Step 4: 테스트 — 회귀 + 단위**

Run: `npm run verify && npx tsx scripts/check-crs.ts`
Expected: `C1 PASS ✅` (center 값 Step 1과 동일) + `CRS PASS ✅`.

- [ ] **Step 5: 타입 체크**

Run: `npx tsc --noEmit`
Expected: 에러 0 (특히 `loadCopcPoints` 호출부·`openCopc` 호출부 타입 정합).

- [ ] **Step 6: Commit**

```bash
git add src/copc-core.ts
git commit -m "refactor(#2): 인라인 georef → resolveCrs+checkCenterInRange (no-CRS throw·sanity 가드)"
```

---

### Task 4: `crs`/`defaultCrs` 옵션 표면화 (페이지 + 워커 세션)

**Files:**
- Modify: `src/copc-tileset.ts` (`CopcTilesetOptions` 라인 20-70; `fromUrl`의 `openCopc(url)` 라인 236; `api.open(...)` 라인 237-244)
- Modify: `src/decode.worker.ts` (`api.open` opts 라인 41-52)
- Test: `npx tsc --noEmit`, `npm run build`

**Interfaces:**
- Consumes: `openCopc(url, { coalesce, crs, defaultCrs })` (Task 3).
- Produces: `CopcTilesetOptions.crs?: string`, `CopcTilesetOptions.defaultCrs?: string`; 워커 `api.open` opts에 `crs`/`defaultCrs`.

- [ ] **Step 1: `CopcTilesetOptions`에 옵션 추가**

`src/copc-tileset.ts`의 `CopcTilesetOptions`(라인 69 `serviceWorkerScope` 위 또는 아래)에 추가:

```ts
  /**
   * CRS override (force) — 파일 헤더 WKT를 무시하고 이 CRS로 배치.
   * proj4 string / WKT / 내장 EPSG(WGS84·UTM·WebMercator). 헤더에 CRS가 없거나 틀릴 때.
   */
  crs?: string;
  /**
   * 헤더에 CRS(WKT)가 없을 때만 적용하는 폴백 CRS(fill-if-missing). `crs`(force)와 구분.
   */
  defaultCrs?: string;
```

- [ ] **Step 2: `fromUrl`에서 두 세션에 전달**

`src/copc-tileset.ts` 라인 235-245의 `Promise.all` 을:

```ts
      const [session] = await Promise.all([
        openCopc(url, { crs: options.crs, defaultCrs: options.defaultCrs }),
        api.open(sid, url, {
          colorBy: options.colorBy ?? 'rgb',
          hideClassifications: options.hideClassifications ?? [7, 18],
          attributes: options.attributes,
          coalesce,
          crs: options.crs,
          defaultCrs: options.defaultCrs,
        }),
      ]);
```

(`--8<--` 스니펫 마커 라인은 그대로 보존.)

- [ ] **Step 3: 워커 `api.open` 가 CRS를 `openCopc`로 전달**

`src/decode.worker.ts` 라인 41-52의 `open`을:

```ts
  async open(
    sid: string,
    url: string,
    opts?: { colorBy?: ColorBy; hideClassifications?: number[]; attributes?: AttributeRequest; coalesce?: CoalesceOpts; crs?: string; defaultCrs?: string },
  ): Promise<void> {
    sessions.set(sid, {
      session: await openCopc(url, { coalesce: opts?.coalesce, crs: opts?.crs, defaultCrs: opts?.defaultCrs }),
      colorBy: opts?.colorBy ?? 'height',
      hideClass: new Set(opts?.hideClassifications ?? []),
      attrReq: opts?.attributes,
    });
  },
```

- [ ] **Step 4: 타입 체크 + 빌드**

Run: `npx tsc --noEmit && npm run build`
Expected: 에러 0, 번들 성공. (브라우저 E2E는 Task 6 수동 확인.)

- [ ] **Step 5: Commit**

```bash
git add src/copc-tileset.ts src/decode.worker.ts
git commit -m "feat(#2): crs/defaultCrs 옵션 표면화 — fromUrl→페이지·워커 세션 전달"
```

---

### Task 5: geoid scope-out 문서화

**Files:**
- Modify: `src/copc-core.ts` (`resolveCrs` 주석 또는 파일 상단)
- Modify: `README.md` (옵션/제약 섹션 — 없으면 옵션 표 근처에 1줄)

**Interfaces:** 없음(문서만).

- [ ] **Step 1: 코드 주석**

`src/copc-core.ts`의 `resolveCrs` JSDoc 끝에 1줄 추가:

```ts
 * 높이(Z)는 선형단위만 보정한 ellipsoidal(HAE)로 취급한다 — geoid/정사고(orthometric) 보정 안 함
 * (web-viewer 업계 norm: Potree·giro3d·py3dtiles 동일). orthometric 입력은 수십 m 수직 오프셋 가능.
```

- [ ] **Step 2: README 1줄**

`README.md`에서 `crs`/`defaultCrs` 옵션을 설명하는 표/목록에 인접해 추가(영문, 기존 README 톤):

```markdown
> **Heights** are treated as ellipsoidal (HAE); geoid/orthometric correction is out of scope
> (matching Potree/giro3d/py3dtiles). Orthometric-height sources may show a vertical offset.
```

(README에 옵션 표가 없으면 `crs`/`defaultCrs` 항목과 함께 Options 섹션에 추가.)

- [ ] **Step 3: Commit**

```bash
git add src/copc-core.ts README.md
git commit -m "docs(#2): CRS 옵션 + geoid scope-out 명시(heights = ellipsoidal)"
```

---

### Task 6: 전체 회귀 검증 (AC 게이트)

**Files:** 없음(검증만).

- [ ] **Step 1: 헤드리스 스위트**

Run: `npm run verify && npx tsx scripts/check-crs.ts && npx tsx scripts/check-ecef.ts`
Expected: `C1 PASS ✅` + `CRS PASS ✅` + `ECEF PASS ✅` 전부 exit 0.

- [ ] **Step 2: 기존 핵심 체크 회귀(georef 영향권)**

Run: `npx tsx scripts/check-coalesce.ts && npx tsx scripts/check-hierarchy.ts`
Expected: 기존 PASS 유지(georef 추출이 디코드/페이징을 깨지 않음 확인).

- [ ] **Step 3: 타입 + 빌드**

Run: `npx tsc --noEmit && npm run build`
Expected: 에러 0, 번들 성공.

- [ ] **Step 4: (수동) 브라우저 스모크 — 옵션 동작**

`npm run dev` → 기본 데모(autzen)가 헤더 WKT로 정상 배치되는지 1회 육안 확인. (옵션 E2E는 데이터 가용성에 의존 — 헤드리스 AC가 1차 게이트.)

- [ ] **Step 5: AC 점검 + Commit (필요 시 문서)**

`docs/superpowers/specs/2026-06-19-crs-auto-placement-design.md`의 AC1~AC7을 결과로 대조. 미충족 있으면 해당 Task로 복귀. 전부 PASS면 spec 체크박스 갱신 후:

```bash
git add docs/superpowers/specs/2026-06-19-crs-auto-placement-design.md
git commit -m "docs(#2): AC1~AC7 검증 완료 체크"
```

---

## Self-Review

**1. Spec coverage (AC1~AC7 → Task):**
- AC1 (no-WKT+override 없음 → throw): Task1 Step1 `no WKT + no override → throw` + Task3(loadCopcPoints/openCopc가 resolveCrs 사용으로 실제 경로 적용).
- AC2 (`crs` force 배치 변경): Task1 `crs override changes result`.
- AC3 (`defaultCrs` fill-if-missing 양 경로): Task1 `defaultCrs ignored when header present` + `applied when header missing`.
- AC4 (garbage → throw): Task1 `garbage CRS → throw`.
- AC5 (center 범위밖 → throw): Task2 `out-of-range center → throw` + `NaN reproject → throw`.
- AC6 (회귀 0): Task3 Step1/4, Task6 Step1-3 (verify·ecef·build·tsc).
- AC7 (geoid 문서화): Task5.
- 갭 없음.

**2. Placeholder scan:** "appropriate error handling"류 추상 표현 없음 — 모든 throw 메시지·테스트 단정 구체화. 코드 블록 모두 실제 내용. OK.

**3. Type consistency:** `CrsOpts`/`resolveCrs`/`checkCenterInRange`/`Reproj` 시그니처가 Task1·2 정의 ↔ Task3·4 사용에서 일치. `openCopc` opts는 `{ coalesce?: CoalesceOpts } & CrsOpts`로 Task3 정의 ↔ Task4 호출 정합. 워커 `open` opts에 `crs`/`defaultCrs` 추가가 `openCopc` 시그니처와 정합. OK.

## 알려진 한계 (spec §6 계승)
- EPSG override는 proj4 내장분만(그 외엔 proj4 string/WKT). 문서화로 대응(풀 레지스트리=B안 follow-up).
- WKT2 `COMPOUNDCRS` 철자 compound는 `extractHorizontalCrs` 미슬라이스(저빈도).
- geoid 미보정(업계 norm).
- GeoTIFF GeoKey 자동복구 미포함(B안).
