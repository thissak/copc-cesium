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

// 독립 오라클(PR#21 dual-review): WGS84(°, m) → ECEF. 구현의 source-공간 메트릭과 무관한 진짜 미터 거리로
// 검증해 순환(오라클=구현 동일공식) 제거 + 비등방 메트릭 버그 검출. WGS84 ellipsoid 표준식.
function toEcef(lonDeg: number, latDeg: number, h: number): [number, number, number] {
  const a = 6378137.0, f = 1 / 298.257223563, e2 = f * (2 - f);
  const lon = (lonDeg * Math.PI) / 180, lat = (latDeg * Math.PI) / 180;
  const sl = Math.sin(lat), cl = Math.cos(lat);
  const N = a / Math.sqrt(1 - e2 * sl * sl);
  return [(N + h) * cl * Math.cos(lon), (N + h) * cl * Math.sin(lon), (N * (1 - e2) + h) * sl];
}
function dist3(a: [number, number, number], b: [number, number, number]): number {
  const dx = a[0] - b[0], dy = a[1] - b[1], dz = a[2] - b[2];
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
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

// (N) nearestPointInNode: 독립 ECEF 오라클로 검증(순환 제거). 씨앗 = 실제 점0 + 수평·수직 *혼합* 오프셋
// (비등방 메트릭 버그가 dist 에 드러나도록). zUnit≠1(피트) CRS서 버그 코드는 여기서 FAIL.
{
  const { nearestPointInNode } = await import('../src/copc-core');
  const view = await Copc.loadPointDataView(s.getter, s.copc, s.nodes['0-0-0-0']);
  const n = view.pointCount;
  const gx = view.getter('X'), gy = view.getter('Y'), gz = view.getter('Z');
  // 씨앗 = 점0 + (수평 0.3, 수직 0.3) source 단위 — 수평·수직 둘 다 0이 아니어야 메트릭 버그가 거리에 보임
  const sxq = gx(0) + 0.3, syq = gy(0), szq = gz(0) + 0.3;
  const hit = await nearestPointInNode(s, '0-0-0-0', sxq, syq, szq, undefined, undefined);
  check('N: hit 반환', !!hit);

  // 독립 오라클: 씨앗·후보를 ECEF 로 변환해 진짜 미터 거리로 최근접/거리 검증 (구현 공식 미사용)
  const seedLL = s.reproj!.forward(sxq, syq);
  const seedEcef = toEcef(seedLL[0], seedLL[1], szq * s.zUnit);
  let bi = -1, bd = Infinity;
  for (let i = 0; i < n; i++) {
    const ll = s.reproj!.forward(gx(i), gy(i));
    const dd = dist3(seedEcef, toEcef(ll[0], ll[1], gz(i) * s.zUnit));
    if (dd < bd) { bd = dd; bi = i; }
  }
  const expected = s.reproj!.forward(gx(bi), gy(bi)); // ECEF-최근접 점
  // (핵심) 반환 dist(미터) == 씨앗↔승자 실제 ECEF 거리 — 비등방 버그면 mixed-unit 값이라 불일치
  const hitEcef = hit ? toEcef(hit.lon, hit.lat, hit.height) : [0, 0, 0] as [number, number, number];
  check('N: dist == ECEF 실거리(미터)', !!hit && Math.abs(hit!.dist - dist3(seedEcef, hitEcef)) < 0.01, `dist=${hit?.dist.toFixed(4)} ecef=${dist3(seedEcef, hitEcef).toFixed(4)}`);
  // 승자가 ECEF-최근접 점과 동일(argmin 정확성)
  check('N: ECEF-최근접 점 선택', !!hit && Math.abs(hit!.lon - expected[0]) < 1e-9 && Math.abs(hit!.lat - expected[1]) < 1e-9, `Δdist=${(dist3(seedEcef, hitEcef) - bd).toExponential(2)}`);
  check('N: height 일치', !!hit && Math.abs(hit!.height - gz(bi) * s.zUnit) < 1e-6);
}

// (N2) 변별 테스트(PR#21 R2): 등방-최근접 ≠ 비등방-최근접 인 씨앗을 찾아 구현이 *등방*(정답)을 고르는지.
// N 의 dist 단언이 committed 버그는 잡지만, argmin 만 비등방으로 남는 부분-회귀를 추가로 막는다.
{
  const { nearestPointInNode } = await import('../src/copc-core');
  const view = await Copc.loadPointDataView(s.getter, s.copc, s.nodes['0-0-0-0']);
  const n = view.pointCount;
  const gx = view.getter('X'), gy = view.getter('Y'), gz = view.getter('Z');
  const zU = s.zUnit;
  const argmin = (qx: number, qy: number, qz: number, aniso: boolean): number => {
    let bi = -1, bd = Infinity;
    for (let i = 0; i < n; i++) {
      const dx = gx(i) - qx, dy = gy(i) - qy, dz = aniso ? (gz(i) - qz) * zU : gz(i) - qz;
      const dd = dx * dx + dy * dy + dz * dz;
      if (dd < bd) { bd = dd; bi = i; }
    }
    return bi;
  };
  // 수직 편중 씨앗(zUnit<1 이면 비등방이 수직거리를 과소평가 → 갈림) 탐색
  let isoBi = -1, qx = 0, qy = 0, qz = 0;
  const scan = Math.min(n, 2000);
  for (let i = 0; i < scan && isoBi < 0; i++) {
    for (const [ox, oy, oz] of [[1, 0, 4], [0.5, 0.5, 3], [2, 0, 6]] as const) {
      const a = argmin(gx(i) + ox, gy(i) + oy, gz(i) + oz, false);
      const b = argmin(gx(i) + ox, gy(i) + oy, gz(i) + oz, true);
      if (a !== b) { isoBi = a; qx = gx(i) + ox; qy = gy(i) + oy; qz = gz(i) + oz; break; }
    }
  }
  if (isoBi >= 0) {
    const hit = await nearestPointInNode(s, '0-0-0-0', qx, qy, qz, undefined, undefined);
    const exp = s.reproj!.forward(gx(isoBi), gy(isoBi));
    check('N2: iso≠aniso 씨앗서 구현이 등방(정답) 선택', !!hit && Math.abs(hit!.lon - exp[0]) < 1e-9 && Math.abs(hit!.lat - exp[1]) < 1e-9, `isoBi=${isoBi}`);
  } else {
    console.log('note — N2: iso≠aniso 갈리는 씨앗 미발견(데이터 의존) → N dist 단언이 메트릭 보장');
  }
}

// (E2E) WGS84 씨앗 → nearestPoint 라운드트립: 실제 점의 lon/lat/height 로 씨앗 → 그 점 복귀.
// 루트 점은 deepest node 에 없으므로(COPC 옥트리 특성) deepest node 의 점을 씨앗으로 사용.
{
  const { nearestPoint, locateDeepestNode } = await import('../src/copc-core');
  // 루트 점0 위치로 deepest node 를 찾아, 그 노드의 실제 점0 을 씨앗으로 사용
  const rootView = await Copc.loadPointDataView(s.getter, s.copc, s.nodes['0-0-0-0']);
  const rx = rootView.getter('X')(0), ry = rootView.getter('Y')(0), rz = rootView.getter('Z')(0);
  const deepKey = await locateDeepestNode(s, rx, ry, rz);
  const view = await Copc.loadPointDataView(s.getter, s.copc, s.nodes[deepKey!]);
  const gx = view.getter('X'), gy = view.getter('Y'), gz = view.getter('Z');
  const ll = s.reproj!.forward(gx(0), gy(0)); // deepest node 점0 의 lon/lat
  const h = gz(0) * s.zUnit;
  const hit = await nearestPoint(s, ll[0], ll[1], h, undefined, undefined);
  check('E2E: hit 반환', !!hit);
  check('E2E: lon≈점0', !!hit && Math.abs(hit!.lon - ll[0]) < 1e-7, `lon=${hit?.lon}`);
  check('E2E: lat≈점0', !!hit && Math.abs(hit!.lat - ll[1]) < 1e-7);
  check('E2E: dist 작음(씨앗=실제점)', !!hit && hit!.dist < 0.5);
}

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

if (failed > 0) { console.error(`\nC-snap FAIL (${failed})`); process.exit(1); }
console.log('\nC-snap PASS ✅');
