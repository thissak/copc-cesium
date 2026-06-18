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

console.log(fails === 0 ? '\nCRS PASS ✅' : `\nCRS FAIL ❌ (${fails})`);
process.exit(fails === 0 ? 0 : 1);
