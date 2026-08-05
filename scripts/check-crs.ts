// CRS 해소·가드 단위 테스트 (헤드리스, Node).
// 실행: npx tsx scripts/check-crs.ts
import { resolveCrs, checkCenterInRange, horizontalSpanMeters } from '../src/copc-core';
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
  const { zUnit } = resolveCrs(MIXED_UNITS_WKT, {});
  ok(Math.abs(zUnit - 1) < 1e-12, `mixed units: vertical metre preserved (zUnit=${zUnit})`);
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

function fakeSession(toWgs: { forward: (xy: number[]) => number[] }, cube: number[], zUnit = 1): CopcSession {
  return {
    copc: { header: { min: cube.slice(0, 3), max: cube.slice(3) } } as never,
    getter: (() => Promise.resolve(new Uint8Array())) as never,
    nodes: { '0-0-0-0': { pointCount: 1 } } as never,
    pages: {},
    toWgs,
    zUnit,
    cube,
    spacing: 1,
    horizontalSpanM: horizontalSpanMeters(toWgs, cube),
  };
}

// EPSG:4326 1° 폭은 약 111km이다. geometric error는 source 단위(도)가 아니라 미터여야 한다.
{
  const s = fakeSession(resolveCrs('+proj=longlat +datum=WGS84 +no_defs').toWgs, [0, 0, 0, 1, 1, 10]);
  const json = buildTileset(s, '/tiles/') as { root: { geometricError: number } };
  ok(json.root.geometricError > 5000, `geographic CRS: geometricError is metric (${json.root.geometricError})`);
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
