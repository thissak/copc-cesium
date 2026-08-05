// CRS 해소·가드 단위 테스트 (헤드리스, Node).
// 실행: npx tsx scripts/check-crs.ts
import {
  resolveCrs,
  checkCenterInRange,
  computeRootSpanM,
  horizontalSpanMeters,
  makeGridReprojector,
  makeSessionMetric,
  sessionMetricMetersSquared,
  sourceMetricMetersSquared,
} from '../src/copc-core';
import { buildTileset } from '../src/tileset';
import type { CopcSession } from '../src/copc-core';

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
const MIXED_UNITS_WKT = `COMPD_CS["UTM feet + metric height",
  PROJCS["WGS 84 / UTM zone 10N feet",
    GEOGCS["WGS 84",DATUM["WGS_1984",SPHEROID["WGS 84",6378137,298.257223563]],
      PRIMEM["Greenwich",0],UNIT["degree",0.0174532925199433]],
    PROJECTION["Transverse_Mercator"],PARAMETER["latitude_of_origin",0],
    PARAMETER["central_meridian",-123],PARAMETER["scale_factor",0.9996],
    PARAMETER["false_easting",1640416.6667],PARAMETER["false_northing",0],
    UNIT["US survey foot",0.3048006096012192]],
  VERT_CS["Ellipsoidal height",VERT_DATUM["Ellipsoid",2002],UNIT["metre",1],AXIS["Up",UP]]]`;
const GEOGRAPHIC_COMPOUND_WKT = `COMPD_CS["NAD83 + NAVD88",
  GEOGCS["NAD83",DATUM["North_American_Datum_1983",SPHEROID["GRS 1980",6378137,298.257222101]],
    PRIMEM["Greenwich",0],UNIT["degree",0.0174532925199433]],
  VERT_CS["NAVD88 height",VERT_DATUM["NAVD88",2005],UNIT["metre",1],AXIS["Up",UP]]]`;
const ESRI_VERTICAL_WKT = MIXED_UNITS_WKT.replace('VERT_CS[', 'VERTCS[');

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

// compound CRS의 수직 단위는 수평 PROJCS 단위와 독립적이다.
{
  const { horizontalUnit, zUnit } = resolveCrs(MIXED_UNITS_WKT, {});
  ok(Math.abs(horizontalUnit - 0.3048006096012192) < 1e-12, `mixed units: horizontal foot preserved (${horizontalUnit})`);
  ok(Math.abs(zUnit - 1) < 1e-12, `mixed units: vertical metre preserved (zUnit=${zUnit})`);
  const horizontalCandidate = sourceMetricMetersSquared(3, 0, 0, horizontalUnit, zUnit);
  const verticalCandidate = sourceMetricMetersSquared(0, 0, 1, horizontalUnit, zUnit);
  ok(horizontalCandidate < verticalCandidate,
    'mixed units: snap chooses 3ft horizontal over 1m vertical distance');
  const metric = Math.sqrt(sourceMetricMetersSquared(3, 0, 1, horizontalUnit, zUnit));
  ok(Math.abs(metric - Math.hypot(3 * horizontalUnit, 1)) < 1e-12,
    'mixed units: snap distance remains isotropic in metres');
}

{
  const { toWgs, horizontalIsAngular, zUnit } = resolveCrs(GEOGRAPHIC_COMPOUND_WKT, {});
  const [lon, lat] = toWgs.forward([-123, 44]);
  ok(Math.abs(lon + 123) < 1e-9 && Math.abs(lat - 44) < 1e-9 && horizontalIsAngular && zUnit === 1,
    'geographic compound CRS extracts horizontal GEOGCS');
  const geographicSession = fakeSession(toWgs, [-123.005, 44.05, 0, 76.995, 244.05, 200], zUnit, true, {
    min: [-123.005, 44.05, 0], max: [-122.995, 44.06, 200],
  });
  const sessionHorizontal = sessionMetricMetersSquared(geographicSession, [-123, 44, 0], [-122.999, 44, 0]);
  const sessionVertical = sessionMetricMetersSquared(geographicSession, [-123, 44, 0], [-123, 44, 1]);
  ok(sessionVertical < sessionHorizontal && Math.abs(Math.sqrt(sessionVertical) - 1) < 1e-6,
    'geographic session metric takes ECEF branch');
  const grid = makeGridReprojector(toWgs, geographicSession.copc.header.min, geographicSession.copc.header.max);
  const gridSession = { ...geographicSession, reproj: grid };
  const exactMetric = makeSessionMetric(geographicSession, [-123, 44.055, 0]);
  const gridMetric = makeSessionMetric(gridSession, [-123, 44.055, 0]);
  ok(Math.abs(Math.sqrt(gridMetric(-122.999, 44.055, 1)) - Math.sqrt(exactMetric(-122.999, 44.055, 1))) < 0.001,
    'geographic grid metric matches proj4 fallback within 1mm');
  const json = buildTileset(geographicSession, '/tiles/') as { root: { boundingVolume: { region: number[] } } };
  const region = json.root.boundingVolume.region;
  ok(region[1] >= 44.049 * Math.PI / 180 && region[3] <= 44.061 * Math.PI / 180,
    'geographic cube XY is clamped to real header bounds');
  let centerThrew = false;
  try { checkCenterInRange(toWgs, [...geographicSession.copc.header.min, ...geographicSession.copc.header.max]); }
  catch { centerThrew = true; }
  ok(!centerThrew, 'geographic center guard uses real header bbox, not min-anchored cube');
}

for (const alias of ['EPSG:4326', 'WGS84']) {
  const { horizontalIsAngular } = resolveCrs(undefined, { crs: alias });
  ok(horizontalIsAngular, `${alias} resolves as angular CRS`);
}

{
  const { zUnit } = resolveCrs(undefined, { crs: '+proj=utm +zone=10 +datum=WGS84 +units=m +vunits=ft' });
  ok(Math.abs(zUnit - 0.3048) < 1e-12, `proj string vertical units preserved (${zUnit})`);
}

{
  const { zUnit } = resolveCrs(ESRI_VERTICAL_WKT);
  ok(zUnit === 1, `ESRI VERTCS vertical metre preserved (${zUnit})`);
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

function fakeSession(
  toWgs: { forward: (xy: number[]) => number[] },
  cube: number[],
  zUnit = 1,
  horizontalIsAngular = false,
  header?: { min: number[]; max: number[] },
): CopcSession {
  const bounds = header ?? { min: cube.slice(0, 3), max: cube.slice(3) };
  return {
    copc: { header: bounds } as never,
    getter: (() => Promise.resolve(new Uint8Array())) as never,
    nodes: { '0-0-0-0': { pointCount: 1 } } as never,
    pages: {},
    pageLoads: new Map(),
    toWgs,
    zUnit,
    horizontalUnit: 1,
    horizontalIsAngular,
    cube,
    spacing: 1,
    rootSpanM: computeRootSpanM(toWgs, [...bounds.min, ...bounds.max], cube, zUnit),
  };
}

{
  const toWgs = resolveCrs(UTM10N).toWgs;
  const span = computeRootSpanM(toWgs, [0, 0, 0, 0, 0, 0], [0, 0, 0, 4656, 4656, 4656], 1);
  ok(span === 4656, `zero header bbox falls back to cube vertical span (${span})`);
}

// EPSG:4326 1° 폭은 약 111km이다. geometric error는 source 단위(도)가 아니라 미터여야 한다.
{
  const s = fakeSession(resolveCrs('+proj=longlat +datum=WGS84 +no_defs').toWgs, [0, 0, 0, 1, 1, 10]);
  const json = buildTileset(s, '/tiles/') as { root: { geometricError: number } };
  ok(json.root.geometricError > 5000, `geographic CRS: geometricError is metric (${json.root.geometricError})`);
}

// 동일 XY의 수직 스캔도 Z span으로 양수 GE를 유지해 child refinement가 멈추지 않아야 한다.
{
  const toWgs = resolveCrs(UTM10N).toWgs;
  const s = fakeSession(toWgs, [500000, 4878000, 0, 500200, 4878200, 200], 1, false, {
    min: [500100, 4878100, 0], max: [500100, 4878100, 200],
  });
  const json = buildTileset(s, '/tiles/') as { root: { geometricError: number } };
  ok(Math.abs(json.root.geometricError - 12.5) < 1e-9,
    `vertical scan: geometricError preserves 200m Z span (${json.root.geometricError})`);
}

// 대각선 두 점 사이에서 위도 극값을 갖는 비선형 변환: region이 변 중간 극값까지 포함해야 한다.
{
  const curved = { forward: ([x, y]: number[]) => [x, y + 10 * x * (1 - x)] };
  const s = fakeSession(curved, [0, 0, 0, 1, 1, 10]);
  const json = buildTileset(s, '/tiles/') as { root: { boundingVolume: { region: number[] } } };
  const northDeg = json.root.boundingVolume.region[3] * 180 / Math.PI;
  ok(northDeg >= 2.5, `curved CRS: region includes edge extrema (north=${northDeg})`);
}

console.log(fails === 0 ? '\nCRS PASS ✅' : `\nCRS FAIL ❌ (${fails})`);
process.exit(fails === 0 ? 0 : 1);
