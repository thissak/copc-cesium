// 점 피킹 헬퍼 결정적 테스트 — fake scene/feature 주입(WebGL 불필요). Cesium 수학만 실제 사용.
import { Cartesian2, Cartesian3, Math as CesiumMath } from 'cesium';
import { pickPoint } from '../src/picking';

let failed = 0;
function check(name: string, cond: boolean): void {
  console.log(`${cond ? 'ok  ' : 'FAIL'} — ${name}`);
  if (!cond) failed++;
}

const tileset = {} as never; // 소유권 판정용 참조 정체성

const feature = {
  primitive: tileset,
  featureId: 7,
  getPropertyIds: () => ['Classification', 'Intensity'],
  getProperty: (id: string) => ({ Classification: 5, Intensity: 5120 } as Record<string, number>)[id],
};

function makeScene(picked: unknown, position: Cartesian3 | undefined, supported = true): never {
  return { pick: () => picked, pickPositionSupported: supported, pickPosition: () => position } as never;
}

const winPos = new Cartesian2(100, 100) as never;
const worldPos = Cartesian3.fromDegrees(-123.07, 44.06, 100);

// (a) 소유 feature → 위치+속성
{
  const r = pickPoint(tileset, makeScene(feature, worldPos), winPos);
  check('a: 결과 정의됨', !!r);
  check('a: featureId=7', r?.featureId === 7);
  check('a: attributes', r?.attributes.Classification === 5 && r?.attributes.Intensity === 5120);
  const lon = r?.cartographic ? CesiumMath.toDegrees(r.cartographic.longitude) : NaN;
  const lat = r?.cartographic ? CesiumMath.toDegrees(r.cartographic.latitude) : NaN;
  check('a: lon≈-123.07', Math.abs(lon - -123.07) < 1e-4);
  check('a: lat≈44.06', Math.abs(lat - 44.06) < 1e-4);
  check('a: height≈100', !!r?.cartographic && Math.abs(r.cartographic.height - 100) < 1e-2);
}
// (b) 타 primitive → undefined
{
  const r = pickPoint(tileset, makeScene({ primitive: {} }, worldPos), winPos);
  check('b: 타 primitive → undefined', r === undefined);
}
// (c) 하늘(pick undefined) → undefined
{
  const r = pickPoint(tileset, makeScene(undefined, worldPos), winPos);
  check('c: 하늘 → undefined', r === undefined);
}
// (d) pickPosition 미지원 → 위치 undefined·속성 존재
{
  const r = pickPoint(tileset, makeScene(feature, undefined, false), winPos);
  check('d: 결과 정의됨', !!r);
  check('d: position undefined', r?.position === undefined);
  check('d: cartographic undefined', r?.cartographic === undefined);
  check('d: attributes 존재', r?.attributes.Classification === 5);
}
// (e) pickPosition 지원하나 런타임 undefined → 위치 undefined·속성 존재 (depth 미가용)
{
  const r = pickPoint(tileset, makeScene(feature, undefined, true), winPos);
  check('e: 결과 정의됨', !!r);
  check('e: position undefined', r?.position === undefined);
  check('e: cartographic undefined', r?.cartographic === undefined);
  check('e: attributes 존재', r?.attributes.Classification === 5);
}
// (f) batch table 없는 점군 — owned 평범한 pick 객체(getPropertyIds 없음, primitive===tileset).
//     Cesium no-feature content pick 객체 모사 → crash 없이 graceful(attributes:{}, featureId 부재).
{
  const plain = { primitive: tileset } as never; // getProperty*/featureId 없는 owned 객체
  const r = pickPoint(tileset, makeScene(plain, worldPos), winPos);
  check('f: 결과 정의됨(crash 없음)', !!r);
  check('f: attributes 빈 객체', !!r && Object.keys(r.attributes).length === 0);
  check('f: featureId 부재', r?.featureId === undefined);
  check('f: 위치 존재', !!r?.cartographic);
}

if (failed > 0) { console.error(`\nC-picking FAIL (${failed})`); process.exit(1); }
console.log('\nC-picking PASS ✅');
