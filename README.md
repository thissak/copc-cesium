# copc-cesium

Stream COPC point clouds directly in CesiumJS — no conversion to 3D Tiles.

`copc-cesium` exposes a [COPC](https://copc.io/) file as a native `Cesium3DTileset`. There is **no offline tiling step**: the original `.copc.laz` is read with HTTP range requests, decoded on demand in a Web Worker, and streamed into Cesium's own LOD / culling machine. One line, like `TIFFImageryProvider` for COG.

```ts
import { Viewer } from 'cesium';
import { CopcTileset } from 'copc-cesium';

// The point cloud needs no Cesium ion token. The default Viewer base imagery does —
// pass `baseLayer: false` (below) or set `Ion.defaultAccessToken` if you want a basemap.
const viewer = new Viewer('app', { baseLayer: false });
const tileset = await CopcTileset.fromUrl('https://example.com/cloud.copc.laz');
viewer.scene.primitives.add(tileset);
```

## Why

Showing a large point cloud in CesiumJS normally means **pre-converting** the data to 3D Tiles (offline tiling, duplicated storage, re-runs on every update). COPC is already a cloud-optimized octree with HTTP range access — so the conversion step is avoidable. `copc-cesium` consumes that structure directly and lets Cesium do the LOD streaming.

## Install

```bash
npm install copc-cesium cesium
```

`cesium` is a peer dependency (bring your own version, `>=1.120`).

## Service worker setup (required)

Cesium fetches tile content over the network, so `copc-cesium` supplies that content through a **service worker**. Copy the bundled worker to a path your server serves at the site root:

```bash
cp node_modules/copc-cesium/dist/copc-sw.js public/copc-sw.js
```

The service worker must be served at a scope that covers the content path (`/__copc-real/…`) — the default root scope (`/copc-sw.js`) does. If it cannot intercept, `fromUrl()` throws a clear error rather than failing silently. Override the location with `serviceWorkerUrl` / `serviceWorkerScope` if needed.

## Options

```ts
await CopcTileset.fromUrl(url, options);
```

| Option | Default | Description |
|--------|---------|-------------|
| `maximumScreenSpaceError` | `8` | Cesium LOD knob — lower = more detail, more load |
| `colorBy` | `'rgb'` | `'rgb'` \| `'height'` \| `'classification'` \| `'intensity'` \| `'returns'` (falls back to height if the dimension is absent) |
| `eyeDomeLighting` | `true` | Eye-dome lighting — depth contours that hide LOD seams (implies `attenuation`) |
| `attenuation` | `true` | Distance-based point-size attenuation |
| `pointSize` | — | Fixed pixel size (applied when attenuation is off) |
| `hideClassifications` | `[7, 18]` | ASPRS classes dropped at decode (default = low/high noise); `[]` keeps all |
| `attributes` | `Classification, Intensity, ReturnNumber, NumberOfReturns` | Per-point LAS attributes exposed to Cesium as a batch table for **dynamic styling and picking**. `undefined` = the curated default; `'all'` = every dimension incl. extra bytes; `string[]` = explicit names (unknown names are skipped with a warning). Exposing attributes adds a `BATCH_ID` (~2–4 B/point). See *Style & pick by attribute* below. |
| `maxRequestsPerServer` | `6` | Max concurrent Cesium requests to the content host. Cesium's default (18) assumes HTTP/2; for HTTP/1.1 range sources (e.g. S3) it over-subscribes one host and causes timeout/retry storms. `6` matches the browser's HTTP/1.1 per-host connection limit. Raise it behind an HTTP/2 CDN; `0` leaves Cesium's default untouched. Applied per-host via `RequestScheduler.requestsByServer` (does not mutate the global). |
| `serviceWorkerUrl` | `'/copc-sw.js'` | Service worker URL |
| `serviceWorkerScope` | `'/'` | Service worker scope (must cover the content path) |
| `crs` | — | Override CRS (force) — ignore the file's WKT and place with this CRS. proj4 string / WKT / built-in EPSG. Use when the header has no/wrong CRS. |
| `defaultCrs` | — | Fallback CRS applied only when the file omits one (fill-if-missing). Distinct from `crs` (force). |

> **CRS / placement:** a georeferenced COPC's embedded WKT is read and reprojected to WGS84 automatically — no config. If the file has **no CRS** (or a wrong one), placement fails loudly with an actionable error; pass `crs` to fix it. Heights are treated as **ellipsoidal (HAE)**; geoid/orthometric correction is out of scope (matching Potree/giro3d/py3dtiles), so orthometric-height sources may show a vertical offset.

The returned object is a normal `Cesium3DTileset`. Call `tileset.destroy()` to release the worker session.

### Style & pick by attribute

Exposed attributes (see `attributes`) reach Cesium's styling language and picking — no conversion, full per-point values straight from the COPC:

```ts
import { Cesium3DTileStyle } from 'cesium';

// Color by classification: ground = brown, building = orange, else cyan.
tileset.style = new Cesium3DTileStyle({
  color: {
    conditions: [
      ['${Classification} === 2', 'color("saddlebrown")'],
      ['${Classification} === 6', 'color("orange")'],
      ['true', 'color("cyan")'],
    ],
  },
  pointSize: '(${Intensity} > 30000) ? 3.0 : 1.0',
});

// Pick a point and read its attributes.
const feature = viewer.scene.pick(windowPosition);
feature?.getProperty('Classification'); // → e.g. 5
feature?.getProperty('Intensity');      // → e.g. 5120
```

`pickPoint(tileset, scene, windowPosition)` is a higher-level helper: one call returns the clicked point's exact location **and** attributes, or `undefined` if the click missed the point cloud (sky, globe, or another tileset):

```ts
import { pickPoint } from 'copc-cesium';

handler.setInputAction((movement) => {
  const hit = pickPoint(tileset, viewer.scene, movement.position);
  if (hit) {
    // hit.cartographic → exact lon/lat/height · hit.attributes → per-point LAS values
    // hit.featureId → tile-local batch id (not a stable global id; absent when no batch table)
    console.log(hit.cartographic, hit.attributes);
  }
}, ScreenSpaceEventType.LEFT_CLICK);
```

If the tileset exposes no attributes (`attributes: []`, or a COPC lacking the curated dimensions), `pickPoint` still returns the location with `attributes: {}` (no throw).

`rampStyle(name, range)` builds a normalized color-ramp style for any attribute, and `await tileset.attributeRange(name)` samples the root node for `[min, max]`:

```ts
import { rampStyle } from 'copc-cesium';
tileset.style = rampStyle('Intensity', await tileset.attributeRange('Intensity'));
```

> Use a concrete color in the catch-all (`color("cyan")`), not `${COLOR}` — the original RGB is not re-exposed as a style variable for batch-table point clouds.

## How it works

- The COPC octree is exposed as a **dynamic `Cesium3DTileset`** (geometricError per node). Cesium's screen-space-error traversal decides which nodes to load — **LOD, culling and memory eviction (`cacheBytes`) are delegated to Cesium.**
- When Cesium requests a node, the **service worker** intercepts the request and routes it to the page, which delegates decode to a **Web Worker** (laz-perf WASM). The node is returned as `.pnts`.
- Deep octrees page their hierarchy sub-pages on demand, so arbitrarily large files stream without reading the whole tree up front.

## Development

This repository started as a competition lab (KOSSA OSSP / Gaia3D task — *"COPC visualization for CesiumJS"*). Internal docs:

- [`docs/DIRECTION.md`](docs/DIRECTION.md) — project direction & roadmap
- [`docs/PROGRESS.md`](docs/PROGRESS.md) — phase checklist
- [`docs/adr/`](docs/adr/) — architecture decisions
- [`docs/PROFILING.md`](docs/PROFILING.md) — 4-axis bottleneck profiling

```bash
npm install
npm run dev        # demo at http://localhost:5173
npm run build:lib  # build the library to dist/
npm run verify     # headless correctness check
```

## License

[Apache-2.0](LICENSE). Runtime dependencies are all permissive:

| Package | Role | License |
|---------|------|---------|
| `cesium` (peer) | render engine | Apache-2.0 |
| `copc` | COPC parsing | MIT |
| `laz-perf` | LAZ decode (WASM) | Apache-2.0 |
| `comlink` | worker RPC | Apache-2.0 |
| `p-retry` | range retry | MIT |
| `proj4` | CRS reprojection | MIT |
