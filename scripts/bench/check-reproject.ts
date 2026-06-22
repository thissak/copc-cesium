// 이슈 #17 재현/진단 — reproject(proj4 수평변환) 비용을 결정적으로 격리.
// 실제 autzen CRS(Lambert→WGS84)로 합성 N점을 변환하며 현재 방식 vs 진단 변형 비교.
// 실행: npx tsx scripts/bench/check-reproject.ts [N=2000000]
import { open } from 'node:fs/promises';
import { Copc } from 'copc';
import proj4 from 'proj4';
import { resolveCrs, makeGridReprojector } from '../../src/copc-core';

const FILE = 'data/norm-autzen-2M.copc.laz';
const N = Number(process.argv[2] || '2000000');

async function fsGetter(path: string) {
  const fh = await open(path, 'r');
  return async (begin: number, end: number): Promise<Uint8Array> => {
    const len = end - begin;
    const buf = Buffer.alloc(len);
    await fh.read(buf, 0, len, begin);
    return new Uint8Array(buf);
  };
}

function ms1m(ms: number): number { return +(ms / (N / 1e6)).toFixed(1); }

async function main() {
  const getter = await fsGetter(FILE);
  const copc = await Copc.create(getter);
  const { toWgs, zUnit } = resolveCrs(copc.wkt);
  const [minx, miny] = copc.header.min;
  const [maxx, maxy] = copc.header.max;

  // 결정적 합성 점 (autzen projected bounds 내 격자형 스프레드, Math.random 미사용)
  const xs = new Float64Array(N), ys = new Float64Array(N), zs = new Float64Array(N);
  for (let i = 0; i < N; i++) {
    const u = (i % 1597) / 1597, v = ((i * 31) % 2503) / 2503; // 서로소 주기로 bounds 채움
    xs[i] = minx + u * (maxx - minx);
    ys[i] = miny + v * (maxy - miny);
    zs[i] = 400 + (i % 200);
  }

  // V0 = 현재 src 방식: 점마다 새 [x,y] 배열 + forward + push (copc-core.ts loadCopcPoints/decodeNode 그대로)
  let t = performance.now();
  const out0: number[] = [];
  for (let i = 0; i < N; i++) {
    const z = zs[i] * zUnit;
    const o = toWgs.forward([xs[i], ys[i]]) as number[];
    out0.push(o[0], o[1], z);
  }
  const v0 = performance.now() - t;

  // V1 진단: 입력 배열 재사용(할당 제거) — 비용이 할당인지 proj4 math인지 분해
  t = performance.now();
  const out1: number[] = [];
  const xy: [number, number] = [0, 0];
  for (let i = 0; i < N; i++) {
    const z = zs[i] * zUnit;
    xy[0] = xs[i]; xy[1] = ys[i];
    const o = toWgs.forward(xy) as number[];
    out1.push(o[0], o[1], z);
  }
  const v1 = performance.now() - t;

  // 정확성: 두 방식 동일 좌표 (첫 점)
  const sane = Math.abs(out0[0] - out1[0]) < 1e-9 && Math.abs(out0[1] - out1[1]) < 1e-9;

  // V2 후보: bounded-extent bilinear 근사 — 모서리 4점만 proj4, 내부는 bilinear 보간.
  //  (Conformal 투영은 소영역서 거의 선형. 정확도는 proj4 대비 max 오차로 실측 검증.)
  const c = (px: number, py: number) => toWgs.forward([px, py]) as number[]; // 모서리 proj4
  const sw = c(minx, miny), se = c(maxx, miny), nw = c(minx, maxy), ne = c(maxx, maxy);
  const dx = maxx - minx, dy = maxy - miny;
  t = performance.now();
  const out2 = new Float64Array(N * 3);
  let maxErrDeg = 0;
  for (let i = 0; i < N; i++) {
    const u = (xs[i] - minx) / dx, vv = (ys[i] - miny) / dy;
    const lon = (1 - u) * (1 - vv) * sw[0] + u * (1 - vv) * se[0] + (1 - u) * vv * nw[0] + u * vv * ne[0];
    const lat = (1 - u) * (1 - vv) * sw[1] + u * (1 - vv) * se[1] + (1 - u) * vv * nw[1] + u * vv * ne[1];
    out2[i * 3] = lon; out2[i * 3 + 1] = lat; out2[i * 3 + 2] = zs[i] * zUnit;
  }
  const v2 = performance.now() - t;
  // 정확도: bilinear vs proj4(V0) 최대 오차 (degrees) — 전 2M점 비교
  for (let i = 0; i < N; i++) {
    const dlon = Math.abs(out2[i * 3] - out0[i * 3]);
    const dlat = Math.abs(out2[i * 3 + 1] - out0[i * 3 + 1]);
    if (dlon > maxErrDeg) maxErrDeg = dlon;
    if (dlat > maxErrDeg) maxErrDeg = dlat;
  }
  const maxErrM = maxErrDeg * 111320; // 대략 도→m (위도 1도≈111.32km)

  console.log(`=== #17 reproject 진단 (autzen CRS, N=${N.toLocaleString()}점) ===`);
  console.log(`CRS: ${String(copc.wkt).slice(0, 50)}…`);
  console.log(`extent: ${dx.toFixed(0)} × ${dy.toFixed(0)} (projected units)`);
  console.log(`V0 현재(새배열+forward+push) : ${v0.toFixed(0)}ms  = ${ms1m(v0)} ms/1M점`);
  console.log(`V1 배열재사용(할당제거)        : ${v1.toFixed(0)}ms  = ${ms1m(v1)} ms/1M점  (Δ ${(((v0 - v1) / v0) * 100).toFixed(0)}%)`);
  console.log(`V2 bilinear 근사(모서리4점)    : ${v2.toFixed(0)}ms  = ${ms1m(v2)} ms/1M점  (V0 대비 ${(v0 / v2).toFixed(1)}× 빠름)`);
  console.log(`  V2 정확도 max 오차: ${maxErrDeg.toExponential(2)} deg ≈ ${maxErrM < 0.01 ? (maxErrM * 1000).toFixed(3) + 'mm' : maxErrM.toFixed(3) + 'm'}`);
  console.log(`정확성(V0==V1 첫점): ${sane ? 'OK' : 'MISMATCH ❌'}`);

  // V3 후보: 격자 bilinear — (G+1)×(G+1) proj4 control 격자, 점은 속한 셀서 bilinear.
  //  오차 ~ 셀크기² 로 급감. G 키워 sub-mm 달성 확인.
  for (const G of [4, 8, 16]) {
    const grid: number[][] = []; // (G+1)^2 control lon/lat
    for (let gy = 0; gy <= G; gy++) for (let gx = 0; gx <= G; gx++) {
      grid.push(c(minx + (gx / G) * dx, miny + (gy / G) * dy));
    }
    const tt = performance.now();
    const o3 = new Float64Array(N * 3);
    for (let i = 0; i < N; i++) {
      const fx = ((xs[i] - minx) / dx) * G, fy = ((ys[i] - miny) / dy) * G;
      let gx = Math.floor(fx), gy = Math.floor(fy);
      if (gx >= G) gx = G - 1; if (gy >= G) gy = G - 1;
      const u = fx - gx, vv = fy - gy;
      const i00 = gy * (G + 1) + gx, i10 = i00 + 1, i01 = i00 + (G + 1), i11 = i01 + 1;
      o3[i * 3] = (1 - u) * (1 - vv) * grid[i00][0] + u * (1 - vv) * grid[i10][0] + (1 - u) * vv * grid[i01][0] + u * vv * grid[i11][0];
      o3[i * 3 + 1] = (1 - u) * (1 - vv) * grid[i00][1] + u * (1 - vv) * grid[i10][1] + (1 - u) * vv * grid[i01][1] + u * vv * grid[i11][1];
    }
    const v3 = performance.now() - tt;
    let err = 0;
    for (let i = 0; i < N; i++) {
      const dl = Math.abs(o3[i * 3] - out0[i * 3]), da = Math.abs(o3[i * 3 + 1] - out0[i * 3 + 1]);
      if (dl > err) err = dl; if (da > err) err = da;
    }
    console.log(`V3 격자 bilinear G=${G}×${G} (${(G + 1) * (G + 1)} proj4) : ${ms1m(v3)} ms/1M점 (${(v0 / v3).toFixed(0)}×)  max오차 ${(err * 111320 * 1000).toFixed(3)}mm`);
  }
  // V4: 실제 src makeGridReprojector (프로덕션 함수 — 가드/폴백 내장, forward(x,y))
  const gr = makeGridReprojector(toWgs, copc.header.min, copc.header.max);
  t = performance.now();
  const out4 = new Float64Array(N * 3);
  for (let i = 0; i < N; i++) {
    const o = gr.forward(xs[i], ys[i]);
    out4[i * 3] = o[0]; out4[i * 3 + 1] = o[1]; out4[i * 3 + 2] = zs[i] * zUnit;
  }
  const v4 = performance.now() - t;
  let err4 = 0;
  for (let i = 0; i < N; i++) {
    const dl = Math.abs(out4[i * 3] - out0[i * 3]), da = Math.abs(out4[i * 3 + 1] - out0[i * 3 + 1]);
    if (dl > err4) err4 = dl; if (da > err4) err4 = da;
  }
  console.log(`V4 src makeGridReprojector (실프로덕션) : ${ms1m(v4)} ms/1M점 (${(v0 / v4).toFixed(0)}×)  max오차 ${(err4 * 111320 * 1000).toFixed(3)}mm`);
  const pass = v4 < v0 * 0.1 && err4 * 111320 < 0.01; // 10×↑ 빠르고 <1cm
  // 가드 건전성 회귀 (dual-review #18 R1): LCC 20km extent — 셀중심-only 가드면 51mm 통과(FAIL).
  // 건전 가드(다점 샘플)면 G 상향/폴백으로 실제 max 오차 < 1mm 유지해야.
  const lcc = proj4('+proj=lcc +lat_1=33 +lat_2=45 +lat_0=39 +lon_0=-96 +x_0=0 +y_0=0 +datum=NAD83 +units=m +no_defs', proj4.WGS84) as unknown as { forward: (c: number[]) => number[] };
  const grL = makeGridReprojector(lcc, [0, 0, 0], [20000, 20000, 0]);
  let errL = 0;
  const S = 150;
  for (let iy = 0; iy <= S; iy++) for (let ix = 0; ix <= S; ix++) {
    const px = (ix / S) * 20000, py = (iy / S) * 20000;
    const g = grL.forward(px, py), tr = lcc.forward([px, py]);
    errL = Math.max(errL, Math.abs(g[0] - tr[0]), Math.abs(g[1] - tr[1]));
  }
  const errLmm = errL * 111320 * 1000;
  const lccOk = errLmm < 1; // 건전 가드면 <1mm (셀중심-only 였으면 ~51mm)
  console.log(`LCC 20km 가드 건전성: 실제 max 오차 ${errLmm.toFixed(3)}mm  ${lccOk ? '✅ (<1mm)' : '❌ (가드가 cm 통과시킴)'}`);

  const allOk = pass && lccOk;
  console.log(allOk ? 'REPROJECT FIX PASS ✅ (src ≥10×·<1cm + LCC20km 가드 건전)' : 'FAIL ❌');
  console.log(`\n해석: V0≈V1 → 비용은 proj4 math. 격자 bilinear(src) 가 수십× + sub-mm. 가드는 다점 샘플로 saddle/방향성 곡률서도 건전(LCC20km).`);
  process.exit(allOk ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
