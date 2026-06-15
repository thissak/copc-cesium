// 헤드리스 검증 하네스 — 브라우저 없이 데이터 파이프라인을 돌려 결과를 stdout 으로 출력.
// 실행: npm run verify   (tsx 로 Node 에서 직접 실행)
// 목적: C1(정확성/georef) + ①②③ timings 를 기계가독으로 확인 (스크린샷 의존 제거).

import { loadCopcPoints } from '../src/copc-core';

const URL = process.argv[2] ?? 'https://s3.amazonaws.com/hobu-lidar/autzen-classified.copc.laz';
const BUDGET = Number(process.argv[3] ?? 50_000);

// Autzen = Oregon. 대략 Oregon 경위도 bbox 로 georef 정확성 판정.
const OREGON = { lonMin: -124.6, lonMax: -116.4, latMin: 41.9, latMax: 46.3 };

const t0 = performance.now();
const r = await loadCopcPoints(URL, BUDGET);
const totalMs = performance.now() - t0;

let lonMin = Infinity;
let lonMax = -Infinity;
let latMin = Infinity;
let latMax = -Infinity;
let hMin = Infinity;
let hMax = -Infinity;
for (let i = 0; i < r.lonLatH.length; i += 3) {
  const lon = r.lonLatH[i];
  const lat = r.lonLatH[i + 1];
  const h = r.lonLatH[i + 2];
  if (lon < lonMin) lonMin = lon;
  if (lon > lonMax) lonMax = lon;
  if (lat < latMin) latMin = lat;
  if (lat > latMax) latMax = lat;
  if (h < hMin) hMin = h;
  if (h > hMax) hMax = h;
}
const cLon = (lonMin + lonMax) / 2;
const cLat = (latMin + latMax) / 2;
const inOregon = cLon > OREGON.lonMin && cLon < OREGON.lonMax && cLat > OREGON.latMin && cLat < OREGON.latMax;

const round = (n: number, d = 5) => Number(n.toFixed(d));
console.log(
  JSON.stringify(
    {
      url: URL,
      pointCount: r.pointCount,
      crs: r.crsWkt?.slice(0, 60),
      center: { lon: round(cLon), lat: round(cLat) },
      bbox: { lonMin: round(lonMin), lonMax: round(lonMax), latMin: round(latMin), latMax: round(latMax) },
      heightM: { min: round(hMin, 1), max: round(hMax, 1) },
      timingsMs: {
        create: round(r.timings.createMs, 0),
        hierarchy: round(r.timings.hierarchyMs, 0),
        fetchDecodeReproject: round(r.timings.fetchDecodeMs, 0),
        total: round(totalMs, 0),
      },
    },
    null,
    2,
  ),
);
console.log(inOregon ? '\nC1 PASS ✅  center is in Oregon' : '\nC1 FAIL ❌  center NOT in Oregon');
process.exit(inOregon ? 0 : 1);
