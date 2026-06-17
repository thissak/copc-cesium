// Cesium-free 색칠 — colorBy 모드별 점당 RGB(평탄 Uint8Array). 모든 색 로직의 단일 소유처(Codex #4).
// 차원이 없으면 호출부(copc-core.decodeNode)가 height 로 폴백한다(조용한 실패 없이 console.warn).

export type ColorBy = 'height' | 'rgb' | 'classification' | 'intensity' | 'returns';

function hue2rgb(m1: number, m2: number, h: number): number {
  if (h < 0) h += 1;
  if (h > 1) h -= 1;
  if (h * 6 < 1) return m1 + (m2 - m1) * 6 * h;
  if (h * 2 < 1) return m2;
  if (h * 3 < 2) return m1 + (m2 - m1) * (2 / 3 - h) * 6;
  return m1;
}

/** Cesium Color.fromHsl 과 동일 (RGB 0-255). */
function hslToRgb(h: number, s: number, l: number, out: Uint8Array, o: number): void {
  h = h % 1;
  const m2 = l <= 0.5 ? l * (s + 1) : l + s - l * s;
  const m1 = 2 * l - m2;
  out[o] = Math.round(hue2rgb(m1, m2, h + 1 / 3) * 255);
  out[o + 1] = Math.round(hue2rgb(m1, m2, h) * 255);
  out[o + 2] = Math.round(hue2rgb(m1, m2, h - 1 / 3) * 255);
}

/**
 * 값 배열 → 저=파랑 고=빨강 HSL 램프 (고도·강도 공용).
 * range=[min,max] 를 주면 그 전역 범위로 정규화(Potree elevationRange 방식 — 노드 간 색 일관),
 * 안 주면 노드 내 min/max 로 폴백. 범위 밖 값은 [0,1] 로 클램프.
 */
function rampColors(values: ArrayLike<number>, n: number, range?: [number, number]): Uint8Array {
  let min: number;
  let max: number;
  if (range) {
    [min, max] = range;
  } else {
    min = Infinity;
    max = -Infinity;
    for (let i = 0; i < n; i++) {
      const v = values[i];
      if (v < min) min = v;
      if (v > max) max = v;
    }
  }
  const span = max - min || 1;
  const out = new Uint8Array(n * 3);
  for (let i = 0; i < n; i++) {
    const t = Math.min(1, Math.max(0, (values[i] - min) / span));
    hslToRgb((1 - t) * 0.66, 1, 0.5, out, i * 3);
  }
  return out;
}

/** 고도 색. range=[minZ,maxZ] 전역 범위(COPC 헤더)로 정규화하면 노드 간 색이 일관(Potree elevationRange). */
export function heightColors(zVals: ArrayLike<number>, n: number, range?: [number, number]): Uint8Array {
  return rampColors(zVals, n, range);
}

export function intensityColors(intensity: ArrayLike<number>, n: number): Uint8Array {
  return rampColors(intensity, n);
}

// ASPRS 표준 classification 대표 코드 팔레트 (그 외 코드는 회색).
const CLASS_PALETTE: Record<number, readonly [number, number, number]> = {
  0: [155, 155, 155], // created/never classified
  1: [180, 180, 180], // unclassified
  2: [166, 116, 64], // ground
  3: [124, 197, 84], // low vegetation
  4: [70, 168, 60], // medium vegetation
  5: [38, 115, 38], // high vegetation
  6: [220, 90, 70], // building
  7: [255, 0, 110], // low point (noise)
  9: [60, 130, 220], // water
  11: [120, 120, 120], // road surface
  17: [200, 200, 90], // bridge deck
};
const CLASS_DEFAULT: readonly [number, number, number] = [150, 150, 150];

export function classificationColors(cls: ArrayLike<number>, n: number): Uint8Array {
  const out = new Uint8Array(n * 3);
  for (let i = 0; i < n; i++) {
    const c = CLASS_PALETTE[cls[i]] ?? CLASS_DEFAULT;
    out[i * 3] = c[0];
    out[i * 3 + 1] = c[1];
    out[i * 3 + 2] = c[2];
  }
  return out;
}

// 리턴 번호별 구분 색 (1~7+, 범위 밖은 양끝으로 클램프).
const RETURN_PALETTE: readonly (readonly [number, number, number])[] = [
  [230, 25, 75],
  [245, 130, 48],
  [255, 225, 25],
  [60, 180, 75],
  [0, 130, 200],
  [145, 30, 180],
  [240, 50, 230],
];

export function returnColors(ret: ArrayLike<number>, n: number): Uint8Array {
  const out = new Uint8Array(n * 3);
  for (let i = 0; i < n; i++) {
    const idx = Math.max(0, Math.min(RETURN_PALETTE.length - 1, (ret[i] | 0) - 1));
    const c = RETURN_PALETTE[idx];
    out[i * 3] = c[0];
    out[i * 3 + 1] = c[1];
    out[i * 3 + 2] = c[2];
  }
  return out;
}

/** 16-bit RGB → 8-bit (LAS RGB 는 보통 uint16; 노드 최댓값 255 초과면 >>8). */
export function rgbColors(
  r: ArrayLike<number>,
  g: ArrayLike<number>,
  b: ArrayLike<number>,
  n: number,
): Uint8Array {
  let max = 0;
  for (let i = 0; i < n; i++) {
    if (r[i] > max) max = r[i];
    if (g[i] > max) max = g[i];
    if (b[i] > max) max = b[i];
  }
  const shift = max > 255 ? 8 : 0;
  const out = new Uint8Array(n * 3);
  for (let i = 0; i < n; i++) {
    out[i * 3] = r[i] >> shift;
    out[i * 3 + 1] = g[i] >> shift;
    out[i * 3 + 2] = b[i] >> shift;
  }
  return out;
}
