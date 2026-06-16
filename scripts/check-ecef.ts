// ECEF 동등성 검증: pnts-quantized 의 WGS84 변환이 Cesium Cartesian3.fromDegrees 와 일치하는지.
// 워커가 Cesium 없이 직접 ECEF 를 계산하므로, 그 공식이 옳은지 mm 급으로 게이트한다.
import { Cartesian3 } from 'cesium';

const A = 6378137.0;
const F = 1 / 298.257223563;
const E2 = F * (2 - F);
const D2R = Math.PI / 180;

function ecef(lonDeg: number, latDeg: number, h: number): [number, number, number] {
  const lon = lonDeg * D2R;
  const lat = latDeg * D2R;
  const sinLat = Math.sin(lat);
  const cosLat = Math.cos(lat);
  const n = A / Math.sqrt(1 - E2 * sinLat * sinLat);
  const r = (n + h) * cosLat;
  return [r * Math.cos(lon), r * Math.sin(lon), (n * (1 - E2) + h) * sinLat];
}

const pts: [number, number, number][] = [
  [-123.0687, 44.0559, 200], // Autzen
  [0, 0, 0],
  [120.5, -33.2, 1500],
  [-123.07, 44.06, -50],
  [179.9, 85, 8000],
];
let maxErr = 0;
for (const [lo, la, h] of pts) {
  const m = ecef(lo, la, h);
  const c = Cartesian3.fromDegrees(lo, la, h);
  const d = Math.hypot(m[0] - c.x, m[1] - c.y, m[2] - c.z);
  if (d > maxErr) maxErr = d;
  console.log(`${lo},${la},${h}  err(m)=${d.toExponential(3)}`);
}
console.log(`\nmaxErr(m)=${maxErr.toExponential(3)}`);
console.log(maxErr < 1e-3 ? 'ECEF PASS ✅ (Cesium 과 sub-mm 일치)' : 'ECEF FAIL ❌');
process.exit(maxErr < 1e-3 ? 0 : 1);
