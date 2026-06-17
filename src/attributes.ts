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
  console.info(`[copc] attributes 해석: [${specs.map((s) => s.batchName).join(', ')}]`);
  return specs;
}
