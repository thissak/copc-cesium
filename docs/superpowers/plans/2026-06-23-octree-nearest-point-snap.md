# 옥트리 풀해상도 최근접점 스냅 (Tier1 #3-B) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 포인트클라우드 클릭 시 COPC 옥트리로 풀해상도 *실제 최근접 점*을 찾아 정확 좌표+속성을 반환한다.

**Architecture:** 순수 math(노드 위치·최근접)는 `copc-core`(Cesium-free, Node 테스트), 디코드는 기존 워커 재사용, Cesium(pickPosition/ECEF)은 page 자유함수에만. 클릭→`pickPosition` 씨앗→워커가 가장 깊은 노드 디코드→씨앗 최근접 점.

**Tech Stack:** TypeScript strict, copc.js(`Copc.loadPointDataView`), laz-perf, proj4(역변환), comlink(워커 RPC), Cesium(page만), tsx(헤드리스 테스트).

## Global Constraints

- TypeScript strict. 기존 파일 스타일 따름. 변경 라인은 요청에 직결.
- 렌더러/스트리밍 primitive 손코딩 금지(ADR-001/ADR-004 위임). 신규 의존성 0.
- `src/`는 출하 라이브러리: `copc-core`/`decode.worker`/`attributes`는 **Cesium import 금지**(Cesium-free 경계). Cesium은 `picking.ts`·`copc-tileset.ts`(page 레이어)만.
- 조용한 실패 금지([[no-silent-failures]]): 부재는 `undefined`/`null`로 명시, 예외는 표면화.
- 속성 키 = `AttributeSpec.batchName`(#3-A `pickPoint`와 동일 키).
- 회귀 게이트: `npm run build`(tsc+vite)·`npm run build:lib`(tsup)·`npm run verify`(autzen C1 Oregon)·기존 `check-*`(ecef/coalesce/paging/picking/attributes/crs/style) 전부 GREEN.
- 테스트 데이터 autzen: `https://s3.amazonaws.com/hobu-lidar/autzen-classified.copc.laz`.

---

### Task 1: `locateDeepestNode` + `Reproj.inverse` (copc-core, 순수)

**Files:**
- Modify: `src/copc-core.ts` (Reproj 타입 + 신규 `locateDeepestNode`)
- Test: `scripts/check-snap.ts` (신규)

**Interfaces:**
- Consumes: `CopcSession`(기존: `cube`, `nodes`, `pages`, `getter`, `toWgs`, `reproj`, `zUnit`), `loadSubPage`(기존).
- Produces: `locateDeepestNode(s: CopcSession, sx: number, sy: number, sz: number): Promise<string | undefined>` — 씨앗(source CRS)을 포함하는 가장 깊은 *실재* 노드 키. 큐브 밖/루트 없음 → undefined. `Reproj` 타입에 `inverse?: (coord: number[]) => number[]`.

- [ ] **Step 1: 실패 테스트 작성** — `scripts/check-snap.ts` 생성

```ts
// 옥트리 최근접점 스냅 결정적 검증 (이슈 #3-B). 실 autzen 노드 + 알려진 씨앗(source CRS).
// 실행: npx tsx scripts/check-snap.ts
import { Copc } from 'copc';
import { openCopc, locateDeepestNode } from '../src/copc-core';

const URL = process.argv[2] ?? 'https://s3.amazonaws.com/hobu-lidar/autzen-classified.copc.laz';
let failed = 0;
function check(name: string, cond: boolean, extra = ''): void {
  console.log(`${cond ? 'ok  ' : 'FAIL'} — ${name}${extra ? '  ' + extra : ''}`);
  if (!cond) failed++;
}

// 키 'D-X-Y-Z' 의 source 큐브 [minx,miny,minz, side] (tileset.ts 규약)
function cubeOf(cube: number[], key: string) {
  const [d, x, y, z] = key.split('-').map(Number);
  const side = (cube[3] - cube[0]) / 2 ** d;
  return { minx: cube[0] + x * side, miny: cube[1] + y * side, minz: cube[2] + z * side, side };
}

const s = await openCopc(URL);

// 루트 노드의 실제 점 하나를 씨앗 source 좌표로
const rootView = await Copc.loadPointDataView(s.getter, s.copc, s.nodes['0-0-0-0']);
const px = rootView.getter('X')(0), py = rootView.getter('Y')(0), pz = rootView.getter('Z')(0);

// (L1) 실재 점 위치 → 가장 깊은 노드 반환, 그 노드 큐브가 점을 포함
{
  const key = await locateDeepestNode(s, px, py, pz);
  check('L1: 노드 키 반환', !!key, `key=${key}`);
  check('L1: 반환 노드가 s.nodes 에 실재', !!key && !!s.nodes[key]);
  if (key) {
    const c = cubeOf(s.cube, key);
    const inside = px >= c.minx && px <= c.minx + c.side && py >= c.miny && py <= c.miny + c.side && pz >= c.minz && pz <= c.minz + c.side;
    check('L1: 씨앗이 노드 큐브 내', inside);
  }
}
// (L2) 큐브 밖 씨앗 → undefined
{
  const key = await locateDeepestNode(s, s.cube[0] - 1e6, py, pz);
  check('L2: 큐브 밖 → undefined', key === undefined);
}

if (failed > 0) { console.error(`\nC-snap FAIL (${failed})`); process.exit(1); }
console.log('\nC-snap PASS ✅');
```

- [ ] **Step 2: 실패 확인**

Run: `npx tsx scripts/check-snap.ts`
Expected: FAIL — `locateDeepestNode` is not exported (import 에러 / not a function).

- [ ] **Step 3: 구현** — `src/copc-core.ts`

`Reproj` 타입에 inverse 추가 (기존 `type Reproj = { forward: (coord: number[]) => number[] };` 교체):

```ts
type Reproj = { forward: (coord: number[]) => number[]; inverse?: (coord: number[]) => number[] };
```

`loadSubPage` 함수 바로 뒤에 추가:

```ts
/**
 * 씨앗(source CRS sx,sy,sz)을 포함하는 가장 깊은 *실재* 옥트리 노드 키 반환 (이슈 #3-B).
 * 루트부터 octant 로 하강하며 s.nodes 존재 확인, 미로드 서브페이지(s.pages)면 loadSubPage 후 재시도.
 * 씨앗이 루트 큐브 밖이거나 루트 노드 부재면 undefined.
 */
export async function locateDeepestNode(s: CopcSession, sx: number, sy: number, sz: number): Promise<string | undefined> {
  const c = s.cube; // [minx,miny,minz,maxx,maxy,maxz] (COPC 큐브)
  const cubeSide = c[3] - c[0];
  if (!(cubeSide > 0)) return undefined;
  if (sx < c[0] || sx > c[0] + cubeSide || sy < c[1] || sy > c[1] + cubeSide || sz < c[2] || sz > c[2] + cubeSide) return undefined;
  if (!s.nodes['0-0-0-0']) return undefined;
  let best = '0-0-0-0';
  let d = 0, x = 0, y = 0, z = 0;
  while (d < 32) {
    const sideD = cubeSide / 2 ** d; // 부모 노드 한 변
    const half = sideD / 2; // 자식 한 변
    const ox = c[0] + x * sideD, oy = c[1] + y * sideD, oz = c[2] + z * sideD;
    const cx = sx >= ox + half ? 1 : 0;
    const cy = sy >= oy + half ? 1 : 0;
    const cz = sz >= oz + half ? 1 : 0;
    const childKey = `${d + 1}-${x * 2 + cx}-${y * 2 + cy}-${z * 2 + cz}`;
    if (s.pages[childKey]) await loadSubPage(s, childKey); // 미로드 서브페이지 → 로드
    if (!s.nodes[childKey]) return best; // 더 깊은 실재 노드 없음 → 현재가 가장 깊음
    best = childKey;
    d += 1; x = x * 2 + cx; y = y * 2 + cy; z = z * 2 + cz;
  }
  return best;
}
```

- [ ] **Step 4: 통과 확인**

Run: `npx tsx scripts/check-snap.ts`
Expected: PASS — `C-snap PASS ✅` (L1·L2 ok).

- [ ] **Step 5: 커밋**

```bash
git add src/copc-core.ts scripts/check-snap.ts
git commit -m "feat(#3-B): locateDeepestNode + Reproj.inverse (옥트리 씨앗 노드 위치)"
```

---

### Task 2: `nearestPointInNode` (copc-core, 순수)

**Files:**
- Modify: `src/copc-core.ts` (신규 `nearestPointInNode`, `AttributeSpec` import 확인)
- Test: `scripts/check-snap.ts` (케이스 추가)

**Interfaces:**
- Consumes: `CopcSession`, `Copc.loadPointDataView`(기존), `AttributeSpec`(기존 import from `./attributes`), `locateDeepestNode`(Task 1).
- Produces: `nearestPointInNode(s, key, sx, sy, sz, attrs, hideClass?, lazPerf?): Promise<NearestHit | null>` where `NearestHit = { lon: number; lat: number; height: number; dist: number; attributes: Record<string, number> }`. `dist`=source 공간 거리(zUnit 적용 Z), `attributes` 키=batchName.

- [ ] **Step 1: 실패 테스트 작성** — `scripts/check-snap.ts` 의 `if (failed > 0)` 줄 **앞에** 추가

```ts
// (N) nearestPointInNode: 알려진 점에 오프셋 씨앗 → 그 점이 최근접(brute-force 대조)
{
  const { nearestPointInNode } = await import('../src/copc-core');
  const view = await Copc.loadPointDataView(s.getter, s.copc, s.nodes['0-0-0-0']);
  const n = view.pointCount;
  const gx = view.getter('X'), gy = view.getter('Y'), gz = view.getter('Z');
  // 타깃 = 점 0, 씨앗 = 타깃 + 작은 오프셋(source 단위)
  const tx = gx(0), ty = gy(0), tz = gz(0);
  const sxq = tx + 0.01, syq = ty, szq = tz;
  // brute-force 최근접 인덱스(같은 메트릭: dx²+dy²+(dz·zUnit)²)
  let bi = -1, bd = Infinity;
  for (let i = 0; i < n; i++) {
    const dx = gx(i) - sxq, dy = gy(i) - syq, dz = (gz(i) - szq) * s.zUnit;
    const dd = dx * dx + dy * dy + dz * dz;
    if (dd < bd) { bd = dd; bi = i; }
  }
  const hit = await nearestPointInNode(s, '0-0-0-0', sxq, syq, szq, undefined, undefined);
  check('N: hit 반환', !!hit);
  check('N: dist ≈ brute-force 최소', !!hit && Math.abs(hit!.dist - Math.sqrt(bd)) < 1e-6, `dist=${hit?.dist.toFixed(4)} bf=${Math.sqrt(bd).toFixed(4)}`);
  const expected = s.reproj!.forward(gx(bi), gy(bi)); // 승자 reproject
  check('N: lon 일치', !!hit && Math.abs(hit!.lon - expected[0]) < 1e-9);
  check('N: lat 일치', !!hit && Math.abs(hit!.lat - expected[1]) < 1e-9);
  check('N: height 일치', !!hit && Math.abs(hit!.height - gz(bi) * s.zUnit) < 1e-6);
}
```

- [ ] **Step 2: 실패 확인**

Run: `npx tsx scripts/check-snap.ts`
Expected: FAIL — `nearestPointInNode` not exported.

- [ ] **Step 3: 구현** — `src/copc-core.ts`, `locateDeepestNode` 바로 뒤에 추가

```ts
export interface NearestHit {
  lon: number;
  lat: number;
  height: number;
  dist: number; // source 공간 거리(수직 zUnit 적용 ≈미터)
  attributes: Record<string, number>;
}

/**
 * 노드(key) 안에서 씨앗(source sx,sy,sz)에 3D 최근접인 실제 점을 찾아 정확 좌표+속성 반환 (이슈 #3-B).
 * 비교는 source 공간(전체 reproject 안 함), 승자 1점만 reproject. hideClass 점은 스킵(렌더와 일관).
 * 노드 없음/0점/전부 스킵 → null.
 */
export async function nearestPointInNode(
  s: CopcSession,
  key: string,
  sx: number,
  sy: number,
  sz: number,
  attrs: AttributeSpec[] | undefined,
  hideClass?: ReadonlySet<number>,
  lazPerf?: LazPerf,
): Promise<NearestHit | null> {
  const node = s.nodes[key];
  if (!node) return null;
  const view = await Copc.loadPointDataView(s.getter, s.copc, node, lazPerf ? { lazPerf } : undefined);
  const n = view.pointCount;
  if (n === 0) return null;
  const gx = view.getter('X');
  const gy = view.getter('Y');
  const gz = view.getter('Z');
  const gc = hideClass?.size && 'Classification' in view.dimensions ? view.getter('Classification') : null;
  let best = -1;
  let bestD2 = Infinity;
  for (let i = 0; i < n; i++) {
    if (gc && hideClass!.has(gc(i) | 0)) continue;
    const dx = gx(i) - sx;
    const dy = gy(i) - sy;
    const dz = (gz(i) - sz) * s.zUnit;
    const d2 = dx * dx + dy * dy + dz * dz;
    if (d2 < bestD2) { bestD2 = d2; best = i; }
  }
  if (best < 0) return null;
  const o = s.reproj ? s.reproj.forward(gx(best), gy(best)) : [gx(best), gy(best)];
  const attributes: Record<string, number> = {};
  if (attrs) for (const spec of attrs) attributes[spec.batchName] = view.getter(spec.lasName)(best);
  return { lon: o[0], lat: o[1], height: gz(best) * s.zUnit, dist: Math.sqrt(bestD2), attributes };
}
```

(`AttributeSpec` 는 이미 `import type { AttributeSpec } from './attributes';` 로 import 됨 — 확인만.)

- [ ] **Step 4: 통과 확인**

Run: `npx tsx scripts/check-snap.ts`
Expected: PASS — N 케이스 ok (dist≈brute-force, lon/lat/height 일치).

- [ ] **Step 5: 커밋**

```bash
git add src/copc-core.ts scripts/check-snap.ts
git commit -m "feat(#3-B): nearestPointInNode (노드 내 source공간 최근접 + 승자 reproject)"
```

---

### Task 3: `nearestPoint` 합성 (copc-core, WGS84 씨앗 E2E)

**Files:**
- Modify: `src/copc-core.ts` (신규 `nearestPoint`)
- Test: `scripts/check-snap.ts` (케이스 추가)

**Interfaces:**
- Consumes: `locateDeepestNode`·`nearestPointInNode`(Task 1·2), `s.toWgs.inverse`(Reproj.inverse), `s.zUnit`.
- Produces: `nearestPoint(s, lon, lat, height, attrs, hideClass?, lazPerf?): Promise<NearestHit | null>` — WGS84 씨앗(도°·m) → 역변환 → locate → nearestInNode.

- [ ] **Step 1: 실패 테스트 작성** — `scripts/check-snap.ts` `if (failed > 0)` 앞에 추가

```ts
// (E2E) WGS84 씨앗 → nearestPoint 라운드트립: 실제 점의 lon/lat/height 로 씨앗 → 그 점 복귀
{
  const { nearestPoint } = await import('../src/copc-core');
  const view = await Copc.loadPointDataView(s.getter, s.copc, s.nodes['0-0-0-0']);
  const gx = view.getter('X'), gy = view.getter('Y'), gz = view.getter('Z');
  const ll = s.reproj!.forward(gx(0), gy(0)); // 점0 의 lon/lat
  const h = gz(0) * s.zUnit;
  const hit = await nearestPoint(s, ll[0], ll[1], h, undefined, undefined);
  check('E2E: hit 반환', !!hit);
  check('E2E: lon≈점0', !!hit && Math.abs(hit!.lon - ll[0]) < 1e-7, `lon=${hit?.lon}`);
  check('E2E: lat≈점0', !!hit && Math.abs(hit!.lat - ll[1]) < 1e-7);
  check('E2E: dist 작음(씨앗=실제점)', !!hit && hit!.dist < 0.5);
}
```

- [ ] **Step 2: 실패 확인**

Run: `npx tsx scripts/check-snap.ts`
Expected: FAIL — `nearestPoint` not exported.

- [ ] **Step 3: 구현** — `src/copc-core.ts`, `nearestPointInNode` 바로 뒤에 추가

```ts
/**
 * WGS84 씨앗(lon°,lat°,height m)에 풀해상도 최근접 실제 점 (이슈 #3-B 합성 진입점).
 * 수평 역변환(toWgs.inverse)·수직 height/zUnit → source 씨앗 → 가장 깊은 노드 → 노드 내 최근접.
 * 역변환 불가/큐브 밖/노드 없음 → null.
 */
export async function nearestPoint(
  s: CopcSession,
  lon: number,
  lat: number,
  height: number,
  attrs: AttributeSpec[] | undefined,
  hideClass?: ReadonlySet<number>,
  lazPerf?: LazPerf,
): Promise<NearestHit | null> {
  if (!s.toWgs?.inverse) return null;
  const src = s.toWgs.inverse([lon, lat]);
  const sx = src[0];
  const sy = src[1];
  const sz = height / s.zUnit;
  if (!Number.isFinite(sx) || !Number.isFinite(sy) || !Number.isFinite(sz)) return null;
  const key = await locateDeepestNode(s, sx, sy, sz);
  if (!key) return null;
  return nearestPointInNode(s, key, sx, sy, sz, attrs, hideClass, lazPerf);
}
```

- [ ] **Step 4: 통과 확인**

Run: `npx tsx scripts/check-snap.ts`
Expected: PASS — E2E ok (lon/lat 라운드트립, dist 작음).

- [ ] **Step 5: 커밋**

```bash
git add src/copc-core.ts scripts/check-snap.ts
git commit -m "feat(#3-B): nearestPoint 합성 (WGS84 씨앗 역변환→locate→nearest)"
```

---

### Task 4: `snapPoint` 자유함수 + `SnappedPoint` (picking.ts, fake scene/query)

**Files:**
- Modify: `src/picking.ts` (신규 `SnappedPoint`·`snapPoint`)
- Modify: `src/index.ts` (export 추가)
- Test: `scripts/check-snap.ts` (fake scene/query 케이스 추가)

**Interfaces:**
- Consumes: Cesium `Cartesian3`·`Cartographic`·`Math`(ECEF·각도), `Cesium3DTileset`·`Scene`·`Cartesian2`(타입).
- Produces:
  - `SnappedPoint { position: Cartesian3; cartographic: Cartographic; attributes: Record<string, number | string>; distanceM: number }`
  - `snapPoint(tileset, scene, windowPosition, query): Promise<SnappedPoint | undefined>` where `query: (seed: { lon: number; lat: number; height: number }) => Promise<{ lon: number; lat: number; height: number; attributes: Record<string, number> } | null>`.

- [ ] **Step 1: 실패 테스트 작성** — `scripts/check-snap.ts` `if (failed > 0)` 앞에 추가

```ts
// (S) snapPoint 자유함수 — fake scene + fake query (Cesium 수학만 실제)
{
  const { snapPoint } = await import('../src/picking');
  const { Cartesian2, Cartesian3, Cartographic, Math: CMath } = await import('cesium');
  const tileset = {} as never;
  const win = new Cartesian2(10, 10) as never;
  const seedECEF = Cartesian3.fromDegrees(-123.07, 44.06, 100);
  const ownedScene = { pick: () => ({ primitive: tileset }), pickPositionSupported: true, pickPosition: () => seedECEF } as never;
  // query 가 -123.0701/44.0601/101 의 점을 반환(약간 떨어진 스냅 점)
  const query = async () => ({ lon: -123.0701, lat: 44.0601, height: 101, attributes: { Classification: 2 } });

  // (S1) 소유 + 씨앗 + query hit → SnappedPoint
  const r = await snapPoint(tileset, ownedScene, win, query);
  check('S1: 결과', !!r);
  check('S1: 속성', r?.attributes.Classification === 2);
  const lon = r ? CMath.toDegrees(r.cartographic.longitude) : NaN;
  check('S1: lon≈-123.0701', Math.abs(lon - -123.0701) < 1e-4);
  // distanceM = 씨앗 ECEF ↔ 스냅점 ECEF
  const snapECEF = Cartesian3.fromDegrees(-123.0701, 44.0601, 101);
  const expectD = Cartesian3.distance(seedECEF, snapECEF);
  check('S1: distanceM≈ECEF거리', !!r && Math.abs(r!.distanceM - expectD) < 1e-3, `d=${r?.distanceM.toFixed(3)} exp=${expectD.toFixed(3)}`);

  // (S2) 타 primitive → undefined (query 미호출)
  let called = false;
  const q2 = async () => { called = true; return null; };
  const r2 = await snapPoint(tileset, { pick: () => ({ primitive: {} }), pickPositionSupported: true, pickPosition: () => seedECEF } as never, win, q2);
  check('S2: 타 primitive → undefined', r2 === undefined);
  check('S2: query 미호출', called === false);

  // (S3) pickPosition 미지원 → undefined
  const r3 = await snapPoint(tileset, { pick: () => ({ primitive: tileset }), pickPositionSupported: false, pickPosition: () => undefined } as never, win, query);
  check('S3: pickPosition 미지원 → undefined', r3 === undefined);

  // (S4) query null(노드/점 없음) → undefined
  const r4 = await snapPoint(tileset, ownedScene, win, async () => null);
  check('S4: query null → undefined', r4 === undefined);
}
```

- [ ] **Step 2: 실패 확인**

Run: `npx tsx scripts/check-snap.ts`
Expected: FAIL — `snapPoint` not exported from picking.

- [ ] **Step 3: 구현** — `src/picking.ts` 끝에 추가 (상단 import 에 `Cartesian3` 추가)

상단 import 수정 (기존 `import { Cartographic } from 'cesium';` 교체):

```ts
import { Cartesian3, Cartographic, Math as CesiumMath } from 'cesium';
```

파일 끝에 추가:

```ts
export interface SnappedPoint {
  position: Cartesian3; // ECEF (스냅된 실제 점)
  cartographic: Cartographic; // lon/lat(rad)·height(m)
  attributes: Record<string, number | string>; // 노출된 LAS 속성(없으면 {})
  distanceM: number; // 씨앗(pickPosition)↔스냅점 ECEF 거리(m)
}

/**
 * windowPosition 의 점이 `tileset` 소유면, 옥트리 풀해상도 최근접 실제 점으로 스냅해 반환 (이슈 #3-B).
 * `query` 는 WGS84 씨앗 → 워커 nearestPoint(데이터 레이어). 씨앗 없음/미소유/스냅 실패 → undefined.
 */
export async function snapPoint(
  tileset: Cesium3DTileset,
  scene: Scene,
  windowPosition: Cartesian2,
  query: (seed: { lon: number; lat: number; height: number }) => Promise<{ lon: number; lat: number; height: number; attributes: Record<string, number> } | null>,
): Promise<SnappedPoint | undefined> {
  const picked = scene.pick(windowPosition) as { primitive?: unknown } | undefined;
  if (!picked || picked.primitive !== tileset) return undefined; // 소유권 가드(#3-A 와 동일)
  const seedPos = scene.pickPositionSupported ? scene.pickPosition(windowPosition) : undefined;
  if (!seedPos) return undefined; // depth 미가용(빈틈/하늘) → 명시적 부재
  const seedCarto = Cartographic.fromCartesian(seedPos);
  const hit = await query({
    lon: CesiumMath.toDegrees(seedCarto.longitude),
    lat: CesiumMath.toDegrees(seedCarto.latitude),
    height: seedCarto.height,
  });
  if (!hit) return undefined; // 노드/점 없음
  const position = Cartesian3.fromDegrees(hit.lon, hit.lat, hit.height);
  return {
    position,
    cartographic: Cartographic.fromCartesian(position),
    attributes: hit.attributes,
    distanceM: Cartesian3.distance(seedPos, position),
  };
}
```

`src/index.ts` — 기존 picking export 줄에 `SnappedPoint`·`snapPoint` 추가 (예: `export { pickPoint, type PickedPoint, snapPoint, type SnappedPoint } from './picking';` — 기존 형식에 맞춰 병합).

- [ ] **Step 4: 통과 확인**

Run: `npx tsx scripts/check-snap.ts`
Expected: PASS — S1~S4 ok.

- [ ] **Step 5: 커밋**

```bash
git add src/picking.ts src/index.ts scripts/check-snap.ts
git commit -m "feat(#3-B): snapPoint 자유함수 + SnappedPoint (pickPosition 씨앗 + query 주입)"
```

---

### Task 5: 워커 `nearestPoint` + `tileset.snapPoint` 메서드 (배선)

**Files:**
- Modify: `src/decode.worker.ts` (api `nearestPoint`)
- Modify: `src/copc-tileset.ts` (`tileset.snapPoint` 메서드)

**Interfaces:**
- Consumes: copc-core `nearestPoint`(Task 3), picking `snapPoint`(Task 4), 기존 `getWorkerApi`·`sid`·`Entry`(session/attrSpecs/hideClass/attrReq).
- Produces:
  - worker api `nearestPoint(sid, seed): Promise<NearestHit | null>`.
  - `tileset.snapPoint(scene, windowPosition): Promise<SnappedPoint | undefined>`.

- [ ] **Step 1: 워커 api 추가** — `src/decode.worker.ts`

상단 import 에 copc-core `nearestPoint`·`resolveAttributes`(이미 import) 확인. `import { openCopc, decodeNode, loadSubPage, nearestPoint as coreNearestPoint, type CopcSession, type CoalesceOpts } from './copc-core';` 로 `nearestPoint` 추가.

`api` 객체의 `close` 앞에 메서드 추가:

```ts
  /** 옥트리 풀해상도 최근접점 (이슈 #3-B). WGS84 씨앗 → 가장 깊은 노드 → 최근접 실제 점. */
  async nearestPoint(
    sid: string,
    seed: { lon: number; lat: number; height: number },
  ): Promise<{ lon: number; lat: number; height: number; dist: number; attributes: Record<string, number> } | null> {
    const e = sessions.get(sid);
    if (!e) throw new Error(`세션 없음: ${sid}`);
    const lazPerf = await getLazPerf();
    // 속성 스펙 미해결이면 루트 노드 dimensions 로 해결(decode 와 동일 차원 — 파일 전역 동일).
    if (!e.attrSpecs && e.session.nodes['0-0-0-0']) {
      const v = await Copc.loadPointDataView(e.session.getter, e.session.copc, e.session.nodes['0-0-0-0'], { lazPerf });
      e.attrSpecs = resolveAttributes(Object.keys(v.dimensions), e.attrReq);
    }
    return coreNearestPoint(e.session, seed.lon, seed.lat, seed.height, e.attrSpecs, e.hideClass, lazPerf);
  },
```

- [ ] **Step 2: tileset 메서드 추가** — `src/copc-tileset.ts`

상단 import 에 picking `snapPoint`·타입 추가: `import { snapPoint, type SnappedPoint } from './picking';` (Cesium-free 경계 무관 — copc-tileset 은 page 레이어).
`Scene`·`Cartesian2` 타입 import (cesium): 기존 `import { Cesium3DTileset, Cesium3DTileStyle, RequestScheduler } from 'cesium';` 에 `import type { Scene, Cartesian2 } from 'cesium';` 추가.

`copcProfile` 메서드 정의 **뒤에** 추가:

```ts
      // 옥트리 풀해상도 최근접점 스냅 (이슈 #3-B). pickPosition 씨앗 → 워커 nearestPoint → SnappedPoint.
      (tileset as unknown as { snapPoint: (scene: Scene, win: Cartesian2) => Promise<SnappedPoint | undefined> }).snapPoint =
        (scene, win) => snapPoint(tileset, scene, win, (seed) => getWorkerApi().nearestPoint(sid, seed));
```

- [ ] **Step 3: 빌드/타입 게이트**

Run: `npm run build && npm run build:lib`
Expected: 둘 다 GREEN. `dist/index.d.ts` 에 `snapPoint`·`SnappedPoint` 존재 확인: `grep -E "snapPoint|SnappedPoint" dist/index.d.ts` → 매치.

- [ ] **Step 4: 결정적 회귀(스냅 데이터경로 무손상)**

Run: `npx tsx scripts/check-snap.ts`
Expected: PASS (Task 1~4 케이스 전부 — 배선이 copc-core/picking 무변경 확인).

- [ ] **Step 5: 커밋**

```bash
git add src/decode.worker.ts src/copc-tileset.ts
git commit -m "feat(#3-B): 워커 nearestPoint + tileset.snapPoint 메서드 배선"
```

---

### Task 6: 데모 패널 + README + 전체 회귀 게이트 + 브라우저 스모크

**Files:**
- Modify: `demo/pick-panel.ts` (스냅 결과 표시)
- Modify: `README.md` (snapPoint 사용)
- Test: 전체 `check-*`·`verify`·`build`·브라우저(autzen)

**Interfaces:**
- Consumes: `tileset.snapPoint`(Task 5), 기존 데모 패널 DOM.

- [ ] **Step 1: 데모 패널에 스냅 표시** — `demo/pick-panel.ts`

기존 LEFT_CLICK 핸들러에서 `pickPoint` 호출 뒤, 우리 tileset 메서드 `snapPoint` 도 호출해 스냅점·거리 추가 표시. 클릭 핸들러 내부에 추가(패널 텍스트에 한 줄):

```ts
    // #3-B: 옥트리 풀해상도 최근접점 스냅(거리 포함). pickPoint 위치와 별도 표기.
    const snapped = await (tileset as unknown as {
      snapPoint?: (scene: typeof viewer.scene, win: typeof movement.position) => Promise<{ cartographic: { longitude: number; latitude: number; height: number }; distanceM: number } | undefined>;
    }).snapPoint?.(viewer.scene, movement.position);
    if (snapped) {
      const d2 = (r: number) => (r * 180 / Math.PI).toFixed(6);
      lines.push(`snap: ${d2(snapped.cartographic.longitude)}°, ${d2(snapped.cartographic.latitude)}°, ${snapped.cartographic.height.toFixed(2)}m (Δ${snapped.distanceM.toFixed(2)}m)`);
    }
```

(기존 패널이 `lines` 배열을 모아 표시한다는 가정 — 실제 변수명에 맞춰 한 줄 추가. 패널 구조가 다르면 동일 의미로 한 줄 추가. 클릭 핸들러는 `async` 로.)

- [ ] **Step 2: README 갱신** — `README.md` 의 "Style & pick" 섹션에 추가

```markdown
### Snap to nearest point (octree, full-resolution)

```ts
const snapped = await tileset.snapPoint(viewer.scene, windowPosition);
// → { position, cartographic, attributes, distanceM } | undefined
// pickPosition 씨앗 위치에서 COPC 옥트리의 가장 깊은 노드를 디코드해 *실제* 최근접 점으로 스냅.
// 빈틈/하늘 클릭(pickPosition 미가용) → undefined.
```
```

- [ ] **Step 3: 전체 회귀 게이트**

```bash
npm run build && npm run build:lib && npm run verify \
  && npx tsx scripts/check-snap.ts \
  && npx tsx scripts/check-picking.ts \
  && npx tsx scripts/check-ecef.ts \
  && npx tsx scripts/check-paging.ts \
  && npx tsx scripts/check-coalesce.ts \
  && npx tsx scripts/check-attributes.ts \
  && npx tsx scripts/check-crs.ts \
  && npx tsx scripts/check-style.ts
```
Expected: 전부 PASS (verify=C1 Oregon, 기존 check-* 회귀 0).

- [ ] **Step 4: 브라우저 스모크(autzen, 실 GPU)** — AC7

`npm run dev` → 브라우저로 autzen 데모 → 점 클릭 → 패널에 `snap: -123.xx°, 44.xx°, ...m (Δ작은값)` + 속성 표시 확인, 빈 공간/하늘 클릭 시 snap 줄 없음, **콘솔 에러 0**. 스크린샷 1장 첨부.

- [ ] **Step 5: 커밋**

```bash
git add demo/pick-panel.ts README.md
git commit -m "feat(#3-B): 데모 스냅 패널 + README + 회귀 게이트 통과"
```

---

## Self-Review

**1. Spec coverage:**
- 동작/범위(씨앗기준 MVP·풀해상도) → Task 1~5. ✅
- 아키텍처(copc-core 순수·워커·page) → Task 1~5 파일 경계 일치. ✅
- 좌표/노드위치 로직(역변환·octant 하강·source공간 거리·승자 reproject) → Task 1·2·3. ✅
- API(`tileset.snapPoint`·copc-core 함수·`SnappedPoint`) → Task 4·5. ✅
- 에러처리(pickPosition 미가용·소유권·NaN·노드없음 → undefined/null) → Task 4(S2~S4)·Task 1(L2)·Task 3(finite 가드). ✅
- AC1(brute-force 최근접)=N, AC2(locateDeepest)=L1·L2 + (깊은 서브페이지 케이스는 millsite 인자로 수동 확인 — Step 6에 `check-snap <millsite-url>` 1회 권장), AC3(undefined 케이스)=S2~S4, AC4(distanceM·속성)=S1·N, AC5(export/build:lib)=Task5 Step3, AC6(회귀)=Task6 Step3, AC7(브라우저)=Task6 Step4. ✅
  - **갭 보완**: AC2 의 "미로드 서브페이지 loadSubPage 후 도달"은 autzen(단일/얕음)서 미검증 가능 → Task 6 Step 3 에 `npx tsx scripts/check-snap.ts https://s3.amazonaws.com/hobu-lidar/millsite.copc.laz` 1회 추가(서브페이지 있는 데이터서 L1 통과 = locate 가 loadSubPage 경유 도달 확인).

**2. Placeholder scan:** "TBD"/"적절히"/빈 코드 없음. 데모 패널 Step 1 은 기존 변수명 가정 1곳(`lines`) 명시 — 실제 구조에 맞춰 "한 줄 추가"로 구체화. ✅

**3. Type consistency:** `NearestHit{lon,lat,height,dist,attributes}` (copc-core, Task2 정의 → Task3 반환 → Task5 워커 반환), `query` 반환 타입(picking, Task4)은 `{lon,lat,height,attributes}`(dist 제외 — page 는 ECEF distanceM 재계산), 워커 nearestPoint 반환은 `NearestHit`(dist 포함하나 page 의 query 시그니처는 dist 무시 → 호환 ✅). `SnappedPoint{position,cartographic,attributes,distanceM}` 일관. `snapPoint(tileset,scene,win,query)` 시그니처 Task4=Task5 호출 일치. `attributes` 키=batchName 일관. ✅

수정 완료(AC2 갭→millsite 1회 추가). 재리뷰 불필요.
