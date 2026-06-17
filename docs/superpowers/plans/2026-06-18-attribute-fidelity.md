# Attribute & Resolution Fidelity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expose per-point LAS attribute values from COPC to Cesium via the pnts batch table, so consumers can dynamically style and pick by any attribute.

**Architecture:** A new resolver (`attributes.ts`) maps requested attributes → typed specs. `decodeNode` reads those dimensions over the kept-point indices. The pnts builder (`pnts-quantized.ts`) writes a BATCH_TABLE + BATCH_ID alongside the existing POSITION_QUANTIZED + RGB. The `attributes` option threads `fromUrl` → worker `open`/`decode` → builder. A `copc-style.ts` helper builds dynamic-range ramp styles.

**Tech Stack:** TypeScript (strict), copc.js (`view.getter(name)`/`view.dimensions`), 3D Tiles 1.0 pnts (BATCH_TABLE + BATCH_ID), CesiumJS (peer). Tests = `npx tsx scripts/check-*.ts` (Node, console-assert + `process.exit(1)` on failure). The data pipeline (`attributes.ts`, `pnts-quantized.ts`, `copc-core.ts`) is Cesium-free → Node-testable. Cesium styling/picking already proven by the `?spikeBatch` PoC.

## Global Constraints

- TypeScript strict; match existing file style; surgical changes only (changed lines trace to this feature).
- No silent failures: unknown/missing attribute → `console.warn` + skip, never throw, tileset keeps working.
- Keep existing `colorBy` baked-RGB as the default color (style-unset behavior unchanged). Zero regression to `verify` (C1 Oregon) and existing 5 `colorBy` modes.
- `pnts-quantized.ts` and `attributes.ts` must NOT import Cesium (worker/Node bundle stays Cesium-free). `copc-style.ts` MAY import Cesium (page-side only).
- pnts batch table follows 3D Tiles 1.0: feature-table binary, batch-table binary each start on 8-byte boundaries; each batch-table property binary starts on a multiple of its component byte size.
- BATCH_ID componentType: `UNSIGNED_SHORT` when point count ≤ 65535, else `UNSIGNED_INT`. BATCH_LENGTH = point count.
- New dependencies: none.

---

## File Structure

- **Create** `src/attributes.ts` — `AttributeRequest`, `AttributeSpec`, `resolveAttributes(availableDims, req)`. Cesium-free. Pure mapping (dim name → typed spec); skip+warn unknown.
- **Create** `src/copc-style.ts` — `rampStyle(attrName, range, palette?)` → `Cesium3DTileStyle`. Cesium import allowed (page-side).
- **Modify** `src/pnts-quantized.ts` — `buildQuantizedPnts(lonLatH, colors, batch?)` writes BATCH_ID + BATCH_LENGTH + BATCH_TABLE when `batch` given.
- **Modify** `src/copc-core.ts` — `decodeNode(..., attrs?)` reads attr dims over `keep` → returns `attrValues`.
- **Modify** `src/decode.worker.ts` — `open` stores `attributes`; resolves specs on first `decode` (caches); passes attr values + specs to builder.
- **Modify** `src/copc-tileset.ts` — `CopcTilesetOptions.attributes`; `fromUrl` passes it to `api.open`; expose `attributeRange(name)` on returned tileset.
- **Create tests** `scripts/check-attributes.ts` (resolver + decode + pnts round-trip, Node), `scripts/check-pnts-batch.ts` (pnts writer round-trip, Node).

---

## Task 1: Attribute resolver (`src/attributes.ts`)

**Files:**
- Create: `src/attributes.ts`
- Test: `scripts/check-attributes.ts` (resolver portion)

**Interfaces:**
- Produces:
  - `type AttributeRequest = undefined | 'all' | string[]`
  - `type ComponentType = 'BYTE'|'UNSIGNED_BYTE'|'SHORT'|'UNSIGNED_SHORT'|'INT'|'UNSIGNED_INT'|'FLOAT'|'DOUBLE'`
  - `interface AttributeSpec { lasName: string; batchName: string; componentType: ComponentType }`
  - `function resolveAttributes(availableDims: string[], req: AttributeRequest): AttributeSpec[]`

- [ ] **Step 1: Write the failing test** (`scripts/check-attributes.ts`)

```ts
// 속성 충실도 검증: resolver + decode + pnts batch table 라운드트립.
// 실행: npx tsx scripts/check-attributes.ts [url]   (기본 autzen)
import { resolveAttributes } from '../src/attributes';

function assert(cond: unknown, msg: string): void {
  if (!cond) { console.error('FAIL: ' + msg); process.exit(1); }
}

// ── resolver ──
const AVAIL = ['X', 'Y', 'Z', 'Intensity', 'Classification', 'ReturnNumber', 'NumberOfReturns', 'GpsTime'];
const def = resolveAttributes(AVAIL, undefined);
assert(def.map((s) => s.batchName).join(',') === 'Classification,Intensity,ReturnNumber,NumberOfReturns',
  'curated default = 4 standard attrs in order, got ' + def.map((s) => s.batchName));
assert(def.find((s) => s.batchName === 'Classification')!.componentType === 'UNSIGNED_BYTE', 'Classification → UNSIGNED_BYTE');
assert(def.find((s) => s.batchName === 'Intensity')!.componentType === 'UNSIGNED_SHORT', 'Intensity → UNSIGNED_SHORT');

const all = resolveAttributes(AVAIL, 'all').map((s) => s.batchName);
assert(!all.includes('X') && all.includes('GpsTime') && all.includes('Classification'), "'all' excludes XYZ, includes GpsTime+Classification, got " + all);

const explicit = resolveAttributes(AVAIL, ['Classification', 'NopeDim']);
assert(explicit.length === 1 && explicit[0].batchName === 'Classification', 'unknown dim skipped, got ' + explicit.map((s) => s.batchName));

console.log('PASS resolver');
process.exit(0);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx scripts/check-attributes.ts`
Expected: FAIL — `Cannot find module '../src/attributes'`.

- [ ] **Step 3: Write minimal implementation** (`src/attributes.ts`)

```ts
// 속성 충실도: 요청된 LAS 차원 → pnts batch table 타입 스펙. Cesium-free(워커/Node 공용).
// 없는 차원은 skip + warn(조용한 실패 없이). extra-bytes/미지정 차원은 FLOAT 로 값 보존.
export type AttributeRequest = undefined | 'all' | string[];

export type ComponentType =
  | 'BYTE' | 'UNSIGNED_BYTE' | 'SHORT' | 'UNSIGNED_SHORT'
  | 'INT' | 'UNSIGNED_INT' | 'FLOAT' | 'DOUBLE';

export interface AttributeSpec {
  lasName: string;
  batchName: string;
  componentType: ComponentType;
}

// 표준 LAS 차원 → 컴포넌트 타입(정밀도 보존). 그 외(extra-bytes 등)는 FLOAT 폴백.
const TYPE_MAP: Record<string, ComponentType> = {
  Classification: 'UNSIGNED_BYTE',
  Intensity: 'UNSIGNED_SHORT',
  ReturnNumber: 'UNSIGNED_BYTE',
  NumberOfReturns: 'UNSIGNED_BYTE',
  ScanAngle: 'SHORT',
  GpsTime: 'DOUBLE',
  PointSourceId: 'UNSIGNED_SHORT',
  UserData: 'UNSIGNED_BYTE',
};

// 큐레이션 기본(lean) — 흔히 스타일·경량.
const CURATED = ['Classification', 'Intensity', 'ReturnNumber', 'NumberOfReturns'];
const POSITION = new Set(['X', 'Y', 'Z']);

export function resolveAttributes(availableDims: string[], req: AttributeRequest): AttributeSpec[] {
  const avail = new Set(availableDims);
  let names: string[];
  if (req === undefined) names = CURATED;
  else if (req === 'all') names = availableDims.filter((d) => !POSITION.has(d));
  else names = req;

  const specs: AttributeSpec[] = [];
  for (const name of names) {
    if (!avail.has(name)) {
      console.warn(`[copc] 속성 '${name}' 없음 → skip`);
      continue;
    }
    specs.push({ lasName: name, batchName: name, componentType: TYPE_MAP[name] ?? 'FLOAT' });
  }
  return specs;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx scripts/check-attributes.ts`
Expected: `PASS resolver` and exit 0.

- [ ] **Step 5: Commit**

```bash
git add src/attributes.ts scripts/check-attributes.ts
git commit -m "feat(attributes): resolveAttributes — LAS dim → typed batch-table spec"
```

---

## Task 2: pnts batch-table writer (`src/pnts-quantized.ts`)

**Files:**
- Modify: `src/pnts-quantized.ts` (extend `buildQuantizedPnts`)
- Test: `scripts/check-pnts-batch.ts`

**Interfaces:**
- Consumes: `AttributeSpec` from `./attributes` (Task 1).
- Produces:
  - `interface BatchData { specs: AttributeSpec[]; values: number[][] }` (values[k] parallel to specs[k], length n)
  - `buildQuantizedPnts(lonLatH: number[], colors: Uint8Array, batch?: BatchData): ArrayBuffer`
  - Helper `componentByteSize(t: ComponentType): number`

- [ ] **Step 1: Write the failing test** (`scripts/check-pnts-batch.ts`)

```ts
// pnts BATCH_TABLE + BATCH_ID 라운드트립: 빌드한 pnts 를 파싱해 구조·값 검증.
import { buildQuantizedPnts } from '../src/pnts-quantized';
import type { AttributeSpec } from '../src/attributes';

function assert(c: unknown, m: string): void { if (!c) { console.error('FAIL: ' + m); process.exit(1); } }

// 2점, lon/lat/h
const lonLatH = [-123.07, 44.06, 100, -123.071, 44.061, 110];
const colors = new Uint8Array([255, 0, 0, 0, 255, 0]);
const specs: AttributeSpec[] = [
  { lasName: 'Classification', batchName: 'Classification', componentType: 'UNSIGNED_BYTE' },
  { lasName: 'Intensity', batchName: 'Intensity', componentType: 'UNSIGNED_SHORT' },
];
const values = [[2, 6], [1000, 40000]];
const buf = buildQuantizedPnts(lonLatH, colors, { specs, values });

// parse pnts header
const dv = new DataView(buf);
const ftJSONlen = dv.getUint32(12, true);
const ftBinLen = dv.getUint32(16, true);
const btJSONlen = dv.getUint32(20, true);
const btBinLen = dv.getUint32(24, true);
assert(btJSONlen > 0 && btBinLen > 0, 'batch table present (JSON+binary lengths > 0)');

const dec = new TextDecoder();
const ftJSON = JSON.parse(dec.decode(new Uint8Array(buf, 28, ftJSONlen)));
assert(ftJSON.BATCH_LENGTH === 2, 'FT BATCH_LENGTH = 2');
assert(ftJSON.BATCH_ID && ftJSON.BATCH_ID.componentType === 'UNSIGNED_SHORT', 'FT BATCH_ID UNSIGNED_SHORT present');

const btJSON = JSON.parse(dec.decode(new Uint8Array(buf, 28 + ftJSONlen + ftBinLen, btJSONlen)));
assert(btJSON.Classification.componentType === 'UNSIGNED_BYTE', 'BT Classification UNSIGNED_BYTE');
assert(btJSON.Intensity.componentType === 'UNSIGNED_SHORT', 'BT Intensity UNSIGNED_SHORT');

// batch table binary: read Classification (offset 0) + Intensity values
const btBinStart = 28 + ftJSONlen + ftBinLen + btJSONlen;
const cls = new Uint8Array(buf, btBinStart + btJSON.Classification.byteOffset, 2);
assert(cls[0] === 2 && cls[1] === 6, 'Classification values [2,6], got ' + cls);
const intRaw = new Uint16Array(buf.slice(btBinStart + btJSON.Intensity.byteOffset, btBinStart + btJSON.Intensity.byteOffset + 4));
assert(intRaw[0] === 1000 && intRaw[1] === 40000, 'Intensity values [1000,40000], got ' + intRaw);

console.log('PASS pnts-batch');
process.exit(0);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx scripts/check-pnts-batch.ts`
Expected: FAIL — `buildQuantizedPnts` ignores 3rd arg → `btJSONlen` is 0 → first assert fails.

- [ ] **Step 3: Write minimal implementation**

In `src/pnts-quantized.ts`, add the import + helper at top, and replace the `buildQuantizedPnts` signature/serialization. Add:

```ts
import type { AttributeSpec, ComponentType } from './attributes';

export interface BatchData {
  specs: AttributeSpec[];
  values: number[][]; // values[k] parallel to specs[k], length n
}

const CT_BYTES: Record<ComponentType, number> = {
  BYTE: 1, UNSIGNED_BYTE: 1, SHORT: 2, UNSIGNED_SHORT: 2,
  INT: 4, UNSIGNED_INT: 4, FLOAT: 4, DOUBLE: 8,
};
function writeTyped(buf: ArrayBuffer, offset: number, t: ComponentType, vals: number[]): void {
  switch (t) {
    case 'BYTE': new Int8Array(buf, offset, vals.length).set(vals); break;
    case 'UNSIGNED_BYTE': new Uint8Array(buf, offset, vals.length).set(vals); break;
    case 'SHORT': new Int16Array(buf, offset, vals.length).set(vals); break;
    case 'UNSIGNED_SHORT': new Uint16Array(buf, offset, vals.length).set(vals); break;
    case 'INT': new Int32Array(buf, offset, vals.length).set(vals); break;
    case 'UNSIGNED_INT': new Uint32Array(buf, offset, vals.length).set(vals); break;
    case 'FLOAT': new Float32Array(buf, offset, vals.length).set(vals); break;
    case 'DOUBLE': new Float64Array(buf, offset, vals.length).set(vals); break;
  }
}
const align = (x: number, a: number): number => Math.ceil(x / a) * a;
```

Then change the function. The existing body builds `ft` + a single feature-table binary (`ftBin`) of POSITION_QUANTIZED + RGB. Modify to (a) append BATCH_ID to the feature-table binary, (b) add BATCH_LENGTH + BATCH_ID to `ft`, (c) build the batch-table JSON + binary, (d) write `batchTableJSONByteLength`/`batchTableBinaryByteLength` (currently hard-coded 0 at offsets 20/24) and append both sections.

Replace the section from `// 2) 양자화 위치 + 색 버퍼` through the `return buf;` with:

```ts
  // 2) 양자화 위치 + 색 + (옵션) BATCH_ID 버퍼
  const posBytes = n * 3 * 2; // uint16 x3
  const rgbBytes = n * 3; // uint8 x3
  const useBatch = !!batch && batch.specs.length > 0 && n > 0;
  const bidType: ComponentType = n > 65535 ? 'UNSIGNED_INT' : 'UNSIGNED_SHORT';
  const bidBytes = useBatch ? n * CT_BYTES[bidType] : 0;
  // BATCH_ID 는 컴포넌트 크기 정렬: posBytes(짝수)+rgbBytes 뒤를 정렬.
  const bidOffset = align(posBytes + rgbBytes, CT_BYTES[bidType]);
  const ftBinLen = align(bidOffset + bidBytes, 8); // FT binary 끝 8B 정렬
  const ftBin = new ArrayBuffer(ftBinLen);
  const q = new Uint16Array(ftBin, 0, n * 3);
  const col = new Uint8Array(ftBin, posBytes, rgbBytes);

  for (let i = 0; i < n; i++) {
    q[i * 3] = quant((ecef[i * 3] - minX) / sx);
    q[i * 3 + 1] = quant((ecef[i * 3 + 1] - minY) / sy);
    q[i * 3 + 2] = quant((ecef[i * 3 + 2] - minZ) / sz);
  }
  col.set(colors.subarray(0, n * 3));
  if (useBatch) {
    const ids = new Array<number>(n);
    for (let i = 0; i < n; i++) ids[i] = i;
    writeTyped(ftBin, bidOffset, bidType, ids);
  }

  // 2b) batch table binary — 속성별 컴포넌트 크기 정렬
  let btBinLen = 0;
  const btProps: Record<string, { byteOffset: number; componentType: ComponentType; type: 'SCALAR' }> = {};
  const btLayout: { offset: number; spec: AttributeSpec; vals: number[] }[] = [];
  if (useBatch) {
    let off = 0;
    for (let k = 0; k < batch!.specs.length; k++) {
      const spec = batch!.specs[k];
      off = align(off, CT_BYTES[spec.componentType]);
      btProps[spec.batchName] = { byteOffset: off, componentType: spec.componentType, type: 'SCALAR' };
      btLayout.push({ offset: off, spec, vals: batch!.values[k] });
      off += n * CT_BYTES[spec.componentType];
    }
    btBinLen = off;
  }
  const btBin = new ArrayBuffer(btBinLen);
  for (const { offset, spec, vals } of btLayout) writeTyped(btBin, offset, spec.componentType, vals);

  // 3) Feature Table JSON
  const ft: Record<string, unknown> = {
    POINTS_LENGTH: n,
    RTC_CENTER: [cx, cy, cz],
    QUANTIZED_VOLUME_OFFSET: [ox, oy, oz],
    QUANTIZED_VOLUME_SCALE: [sx, sy, sz],
    POSITION_QUANTIZED: { byteOffset: 0 },
    RGB: { byteOffset: posBytes },
  };
  if (useBatch) {
    ft.BATCH_LENGTH = n;
    ft.BATCH_ID = { byteOffset: bidOffset, componentType: bidType };
  }
  let ftJSON = JSON.stringify(ft);
  while ((28 + ftJSON.length) % 8 !== 0) ftJSON += ' ';
  const ftJSONbytes = new TextEncoder().encode(ftJSON);

  // Batch Table JSON — 8B 경계에서 BT binary 시작
  let btJSONbytes = new Uint8Array(0);
  if (useBatch) {
    let btJSON = JSON.stringify(btProps);
    while ((28 + ftJSONbytes.length + ftBinLen + btJSON.length) % 8 !== 0) btJSON += ' ';
    btJSONbytes = new TextEncoder().encode(btJSON);
  }

  const headerLen = 28;
  const total = headerLen + ftJSONbytes.length + ftBinLen + btJSONbytes.length + btBinLen;
  const padded = Math.ceil(total / 8) * 8;
  const buf = new ArrayBuffer(padded);
  const dv = new DataView(buf);
  const u8 = new Uint8Array(buf);
  dv.setUint8(0, 0x70); dv.setUint8(1, 0x6e); dv.setUint8(2, 0x74); dv.setUint8(3, 0x73);
  dv.setUint32(4, 1, true);
  dv.setUint32(8, padded, true);
  dv.setUint32(12, ftJSONbytes.length, true);
  dv.setUint32(16, ftBinLen, true);
  dv.setUint32(20, btJSONbytes.length, true);
  dv.setUint32(24, btBinLen, true);
  let w = headerLen;
  u8.set(ftJSONbytes, w); w += ftJSONbytes.length;
  u8.set(new Uint8Array(ftBin), w); w += ftBinLen;
  u8.set(btJSONbytes, w); w += btJSONbytes.length;
  u8.set(new Uint8Array(btBin), w);
  return buf;
```

And change the signature line to:
```ts
export function buildQuantizedPnts(lonLatH: number[], colors: Uint8Array, batch?: BatchData): ArrayBuffer {
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx scripts/check-pnts-batch.ts`
Expected: `PASS pnts-batch`, exit 0. Also run `npx tsc --noEmit` → no errors.

- [ ] **Step 5: Commit**

```bash
git add src/pnts-quantized.ts scripts/check-pnts-batch.ts
git commit -m "feat(pnts): BATCH_TABLE + BATCH_ID writer (typed, aligned)"
```

---

## Task 3: `decodeNode` reads attribute values (`src/copc-core.ts`)

**Files:**
- Modify: `src/copc-core.ts` (`decodeNode` + reuse `readArr`)
- Test: extend `scripts/check-attributes.ts`

**Interfaces:**
- Consumes: `AttributeSpec` from `./attributes`.
- Produces: `decodeNode(s, key, lazPerf?, colorBy?, hideClass?, attrs?: AttributeSpec[])` now returns
  `{ lonLatH, zVals, count, colors?, attrValues?: number[][] }` where `attrValues[k]` is parallel to `attrs[k]`, length = kept-point count.

- [ ] **Step 1: Write the failing test** (append to `scripts/check-attributes.ts`, before its final `process.exit(0)`)

```ts
// ── decode (real autzen) ──
import { Copc } from 'copc';
import { openCopc, decodeNode } from '../src/copc-core';

const url = process.argv[2] ?? 'https://s3.amazonaws.com/hobu-lidar/autzen-classified.copc.laz';
const s = await openCopc(url);
const rootKey = '0-0-0-0';
const view0 = await Copc.loadPointDataView(s.getter, s.copc, s.nodes[rootKey]!);
const dims = Object.keys(view0.dimensions);
const specs = resolveAttributes(dims, ['Classification', 'Intensity']);
assert(specs.length === 2, 'autzen has Classification + Intensity');

const nd = await decodeNode(s, rootKey, undefined, 'rgb', new Set([7, 18]), specs);
assert(nd && nd.attrValues && nd.attrValues.length === 2, 'attrValues returned for 2 specs');
assert(nd!.attrValues![0].length === nd!.count, 'attrValues[0] length === kept count');

// cross-check: first kept point's Classification matches a fresh raw read at the same kept index
const gc = view0.getter('Classification');
// kept indices: reproduce the hideClass filter to find first kept original index
let firstKept = -1;
for (let i = 0; i < view0.pointCount; i++) { const c = gc(i) | 0; if (c !== 7 && c !== 18) { firstKept = i; break; } }
assert(firstKept >= 0, 'has a kept point');
assert(nd!.attrValues![0][0] === (gc(firstKept) | 0), 'first kept Classification matches raw, got ' + nd!.attrValues![0][0] + ' vs ' + (gc(firstKept) | 0));

console.log('PASS decode-attributes');
process.exit(0);
```

(Remove the earlier `console.log('PASS resolver'); process.exit(0);` lines from Task 1 so the file runs resolver + decode in one pass; keep the resolver asserts.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx scripts/check-attributes.ts`
Expected: FAIL — `decodeNode` has no `attrs` param / returns no `attrValues` (TS error or assert fail).

- [ ] **Step 3: Write minimal implementation**

In `src/copc-core.ts`: add the import `import type { AttributeSpec } from './attributes';`. Change `decodeNode` signature + return:

```ts
export async function decodeNode(
  s: CopcSession,
  key: string,
  lazPerf?: LazPerf,
  colorBy?: ColorBy,
  hideClass?: ReadonlySet<number>,
  attrs?: AttributeSpec[],
): Promise<{ lonLatH: number[]; zVals: number[]; count: number; colors?: Uint8Array; attrValues?: number[][] } | null> {
```

Then before the final `return`, after `const colors = ...`, add:

```ts
  const attrValues = attrs?.length
    ? attrs.map((spec) => readArr(view.getter(spec.lasName), keep))
    : undefined;
  return { lonLatH, zVals, count: keep.length, colors, attrValues };
```

(Replace the existing `return { lonLatH, zVals, count: keep.length, colors };`.)

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx scripts/check-attributes.ts`
Expected: `PASS resolver` … `PASS decode-attributes`, exit 0. Then `npm run verify` → `C1 PASS ✅` (no regression).

- [ ] **Step 5: Commit**

```bash
git add src/copc-core.ts scripts/check-attributes.ts
git commit -m "feat(decode): decodeNode reads attribute values over kept points"
```

---

## Task 4: Wire `attributes` through worker + `fromUrl` (`decode.worker.ts`, `copc-tileset.ts`)

**Files:**
- Modify: `src/decode.worker.ts` (`open` stores request; `decode` resolves+caches specs, passes to `decodeNode` + `buildQuantizedPnts`)
- Modify: `src/copc-tileset.ts` (`CopcTilesetOptions.attributes`; `fromUrl` → `api.open`)
- Test: browser PoC against real COPC (manual/Playwright), plus `npm run build`

**Interfaces:**
- Consumes: `resolveAttributes`, `AttributeSpec`, `BatchData`, `decodeNode(...attrs)`, `buildQuantizedPnts(...batch)`.
- Produces: `CopcTilesetOptions.attributes?: AttributeRequest`; worker `open(sid, url, { colorBy?, hideClassifications?, attributes? })`.

- [ ] **Step 1: Modify the worker `open`/`decode`** (`src/decode.worker.ts`)

Add imports: `import { resolveAttributes, type AttributeRequest, type AttributeSpec } from './attributes';` and add `BatchData` is internal to the builder (no import needed; pass `{ specs, values }`).

Change `Entry` and `open`:
```ts
type Entry = {
  session: CopcSession;
  colorBy: ColorBy;
  hideClass: Set<number>;
  attrReq: AttributeRequest;
  attrSpecs?: AttributeSpec[]; // 첫 decode 때 view.dimensions 로 확정·캐시
};
```
In `open`, accept + store `opts?.attributes`:
```ts
sessions.set(sid, {
  session: await openCopc(url),
  colorBy: opts?.colorBy ?? 'height',
  hideClass: new Set(opts?.hideClassifications ?? []),
  attrReq: opts?.attributes,
});
```
(Update `open`'s `opts` type to include `attributes?: AttributeRequest`.)

Change `decode` to resolve specs on first call and pass them through:
```ts
async decode(sid: string, key: string): Promise<ArrayBuffer | null> {
  const e = sessions.get(sid);
  if (!e) throw new Error(`세션 없음: ${sid}`);
  const lazPerf = await getLazPerf();
  // 속성 스펙은 차원 목록이 필요 → 첫 디코드의 view 로 확정·캐시
  if (e.attrSpecs === undefined) {
    const node = e.session.nodes[key];
    if (node) {
      const v = await Copc.loadPointDataView(e.session.getter, e.session.copc, node, { lazPerf });
      e.attrSpecs = resolveAttributes(Object.keys(v.dimensions), e.attrReq);
    }
  }
  const nd = await decodeNode(e.session, key, lazPerf, e.colorBy, e.hideClass, e.attrSpecs);
  if (!nd) return null;
  const batch = e.attrSpecs && e.attrSpecs.length && nd.attrValues
    ? { specs: e.attrSpecs, values: nd.attrValues }
    : undefined;
  const pnts = buildQuantizedPnts(nd.lonLatH, nd.colors!, batch);
  return Comlink.transfer(pnts, [pnts]);
},
```
Add `import { Copc } from 'copc';` to the worker (for the dimensions probe) — already imported via `openCopc`? It is NOT; add `import { Copc } from 'copc';`.

- [ ] **Step 2: Add the `attributes` option** (`src/copc-tileset.ts`)

Add to `CopcTilesetOptions` (after `hideClassifications`):
```ts
  /**
   * Cesium 에 노출할 per-point 속성(동적 스타일링·피킹용 batch table).
   * `undefined`=큐레이션 기본(Classification·Intensity·ReturnNumber·NumberOfReturns),
   * `'all'`=extra-bytes 포함 전체, `string[]`=명시(없는 차원은 skip+warn). 노출하면 BATCH_ID 추가(+2~4B/점).
   */
  attributes?: AttributeRequest;
```
Add import: `import type { AttributeRequest } from './attributes';`.
In `fromUrl`, pass it to `api.open`:
```ts
        api.open(sid, url, {
          colorBy: options.colorBy ?? 'rgb',
          hideClassifications: options.hideClassifications ?? [7, 18],
          attributes: options.attributes,
        }),
```

- [ ] **Step 3: Build + type-check**

Run: `npm run build` (tsc --noEmit + vite) → no TS errors, demo builds.
Run: `npm run build:lib` → tsup builds, `dist/index.d.ts` includes `attributes`.

- [ ] **Step 4: Browser verification (real COPC style + pick)**

Start dev server (`npm run dev`) if not running. With Playwright (or manually), load the default demo (autzen) — `fromUrl` now ships the curated batch table. In the page console / via evaluate, set a style and pick:
```js
const ts = viewer.scene.primitives.get(viewer.scene.primitives.length - 1);
ts.style = new Cesium.Cesium3DTileStyle({ color: { conditions: [['${Classification} === 2','color("brown")'],['true','${COLOR}']] } });
// pick: scene.pick(windowPos) → feature.getProperty('Classification')
```
Expected: ground points (class 2) turn brown; picking a point returns its Classification. (PoC `?spikeBatch` already proved the mechanism; this confirms the REAL pipeline.) Note: `Cesium` is not on `window` — verify via a temporary `?spikeReal` branch mirroring `?spikeBatch` but loading `CopcTileset.fromUrl(autzen)` then applying the style, OR extend the existing `?spikeBatch` to load real data. Capture a screenshot + the picked Classification.

- [ ] **Step 5: Commit**

```bash
git add src/decode.worker.ts src/copc-tileset.ts
git commit -m "feat: attributes option → worker batch table (fromUrl → open → decode → pnts)"
```

---

## Task 5: Dynamic-range ramp helper (`src/copc-style.ts`) + `attributeRange`

**Files:**
- Create: `src/copc-style.ts`
- Modify: `src/copc-tileset.ts` (export helper; add `attributeRange(name)` to returned tileset)
- Test: `scripts/check-attributes.ts` (range from root sample) + `src/copc-style.ts` unit via a tiny Node check `scripts/check-style.ts`

**Interfaces:**
- Produces:
  - `rampStyle(attrName: string, range: [number, number], palette?: string[]): Cesium3DTileStyle`
  - `tileset.attributeRange(name: string): Promise<[number, number]>` (root-node sample min/max)

- [ ] **Step 1: Write the failing test** (`scripts/check-style.ts`)

```ts
import { rampStyle } from '../src/copc-style';
function assert(c: unknown, m: string): void { if (!c) { console.error('FAIL: ' + m); process.exit(1); } }
const style = rampStyle('Intensity', [0, 65535]);
assert(style && (style as { color?: unknown }).color, 'rampStyle returns a style with a color expression');
console.log('PASS style');
process.exit(0);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx scripts/check-style.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement** (`src/copc-style.ts`)

```ts
// 동적범위 램프 스타일 — 임의 속성을 [min,max] 로 정규화해 파랑→빨강 HSL 램프.
// 페이지측(Cesium import 허용). dynamic-range 스타일링(Cesium staff "미지원")을 우리가 열어주는 헬퍼.
import { Cesium3DTileStyle } from 'cesium';

const DEFAULT_RAMP = ['rgb(43,131,186)', 'rgb(171,221,164)', 'rgb(255,255,191)', 'rgb(253,174,97)', 'rgb(215,25,28)'];

/** ${attrName} 를 [min,max] 정규화해 palette 색 구간으로 매핑하는 Cesium3DTileStyle. */
export function rampStyle(attrName: string, range: [number, number], palette: string[] = DEFAULT_RAMP): Cesium3DTileStyle {
  const [min, max] = range;
  const span = max - min || 1;
  const conditions: [string, string][] = [];
  for (let k = 0; k < palette.length; k++) {
    const hi = min + (span * (k + 1)) / palette.length;
    conditions.push([`\${${attrName}} <= ${hi}`, `color('${palette[k]}')`]);
  }
  conditions.push(['true', `color('${palette[palette.length - 1]}')`]);
  return new Cesium3DTileStyle({ color: { conditions } });
}
```

- [ ] **Step 4: `attributeRange` on the tileset** (`src/copc-tileset.ts`)

After building `tileset` in `fromUrl`, attach a method that samples the page-side root session (`pageSessions.get(sid)`) for the attribute min/max:
```ts
(tileset as unknown as { attributeRange: (name: string) => Promise<[number, number]> }).attributeRange = async (name) => {
  const session = pageSessions.get(sid)!;
  const view = await Copc.loadPointDataView(session.getter, session.copc, session.nodes['0-0-0-0']!);
  const g = view.getter(name);
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < view.pointCount; i++) { const v = g(i); if (v < lo) lo = v; if (v > hi) hi = v; }
  return [lo, hi];
};
```
Add `import { Copc } from 'copc';` to `copc-tileset.ts` (not currently imported). Re-export the helper from `src/index.ts`: `export { rampStyle } from './copc-style';`.

- [ ] **Step 5: Run + commit**

Run: `npx tsx scripts/check-style.ts` → `PASS style`. `npm run build` → OK.
```bash
git add src/copc-style.ts src/copc-tileset.ts src/index.ts scripts/check-style.ts
git commit -m "feat(style): rampStyle helper + tileset.attributeRange (dynamic-range styling)"
```

---

## Task 6: extra-bytes for `'all'` (stretch)

**Files:**
- Modify: `src/attributes.ts` (type inference for non-standard dims)
- Test: `scripts/check-attributes.ts` (extra-bytes dim presence if a file has them)

**Interfaces:**
- Consumes/Produces: same `resolveAttributes` — extends type inference for dims not in `TYPE_MAP`.

- [ ] **Step 1:** Confirm copc.js exposes extra-byte dimensions in `view.dimensions` and that `view.getter(name)` returns their (scaled) values. Quick probe:

```bash
npx tsx -e "import {Copc} from 'copc'; import {openCopc} from './src/copc-core'; const s=await openCopc(process.argv[1]); const v=await Copc.loadPointDataView(s.getter,s.copc,s.nodes['0-0-0-0']); console.log(Object.keys(v.dimensions)); process.exit(0)" <copc-url-with-extra-bytes>
```
Expected: dimension list includes extra-byte names. **If no such file is available, document the gap (AC#4) and keep the current `FLOAT` fallback — the `'all'` path already includes them via `availableDims`.**

- [ ] **Step 2:** If extra-byte dims appear, no code change is required for VALUE exposure (already handled by `'all'` + `FLOAT` fallback). Optionally refine `componentType` using copc.js dimension metadata; only do this if `view.dimensions[name]` exposes a usable type and a test file exists. Otherwise, **skip — YAGNI** and rely on `FLOAT` (preserves integers ≤ 2^24).

- [ ] **Step 3: Commit (only if changed)**

```bash
git add src/attributes.ts scripts/check-attributes.ts
git commit -m "feat(attributes): extra-bytes via 'all' (FLOAT-preserved values)"
```

---

## Task 7: Regression + docs

**Files:**
- Modify: `README.md` (options table: `attributes` row + styling/picking note), `docs/CHANGELOG.md` (entry)
- Verify: full suite

- [ ] **Step 1: Run the full regression**

```bash
npm run build        # tsc + vite demo
npm run build:lib    # tsup → dist (.d.ts includes attributes, rampStyle)
npm run verify       # C1 Oregon PASS (no regression)
npx tsx scripts/check-attributes.ts
npx tsx scripts/check-pnts-batch.ts
npx tsx scripts/check-style.ts
```
Expected: all PASS / `C1 PASS ✅`.

- [ ] **Step 2: README options table** — add row after `hideClassifications`:

```markdown
| `attributes` | curated 4 | Per-point LAS attributes exposed to Cesium (batch table) for **dynamic styling + picking**. `undefined` = `Classification, Intensity, ReturnNumber, NumberOfReturns`; `'all'` = every dimension incl. extra-bytes; `string[]` = explicit (unknown names skipped). Adds a `BATCH_ID` (+2–4 B/point). Style via `Cesium3DTileStyle({ color: { conditions: [['${Classification} === 2', ...]] } })`; pick via `Cesium3DTileFeature.getProperty('Classification')`. |
```

- [ ] **Step 3: CHANGELOG** — add a `[feat]` entry under today's date summarizing: opt-in `attributes` → pnts BATCH_TABLE + BATCH_ID → Cesium dynamic styling/picking; `rampStyle` helper; PoC-confirmed; component list; AC verified.

- [ ] **Step 4: Decide PoC spike fate** — keep `?spikeBatch` (demonstration, like other `?spike` branches) OR remove `src/spike-batch.ts` + its `main.ts` branch. Recommend: keep as `?spikeBatch` (cheap, demonstrates capability).

- [ ] **Step 5: Commit**

```bash
git add README.md docs/CHANGELOG.md
git commit -m "docs: attributes option (dynamic styling/picking) — README + CHANGELOG"
```

---

## Self-Review

**Spec coverage:** §4 data flow → Tasks 3/4; §5 components 1–4 → Tasks 1/2/3/5; §6 curated default + BATCH_ID + typed encoding → Tasks 1/2; §6 colorBy-RGB-default kept → Task 3/4 (decodeNode still computes `colors`, builder still writes RGB); §7 error handling → Task 1 (skip+warn); §8 AC1–8 → Tasks 1–7; §9 test scenarios → check-attributes (normal/edge) + check-pnts-batch; §10 extra-bytes gap → Task 6; out-of-scope position precision → untouched.

**Placeholder scan:** none — every code/test step has concrete content; Task 6 explicitly resolves to "skip (YAGNI)" if no extra-bytes file, not a TODO.

**Type consistency:** `AttributeSpec`/`ComponentType`/`AttributeRequest` defined in Task 1, consumed verbatim in Tasks 2–5. `decodeNode(...attrs)` return `attrValues: number[][]` (Task 3) consumed by worker (Task 4). `buildQuantizedPnts(lonLatH, colors, batch?)` (Task 2) called in Task 4. `resolveAttributes(availableDims, req)` (Task 1) called in Task 4 worker.

**Known risk:** Task 4 browser verification needs a Cesium-class-reachable path (window.Cesium absent) — handled by a temporary `?spikeReal` branch or extending `?spikeBatch`; the PoC already de-risked the Cesium mechanism, so this confirms the real pipeline only.
