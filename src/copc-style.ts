// 동적범위 램프 스타일 — 임의 속성을 [min,max] 로 정규화해 파랑→빨강 HSL 램프.
// 페이지측(Cesium import 허용). dynamic-range 스타일링(Cesium staff "미지원")을 우리가 열어주는 헬퍼.
import { Cesium3DTileStyle } from 'cesium';

const DEFAULT_RAMP = ['rgb(43,131,186)', 'rgb(171,221,164)', 'rgb(255,255,191)', 'rgb(253,174,97)', 'rgb(215,25,28)'];

/** ${attrName} 를 [min,max] 정규화해 palette 색 구간으로 매핑하는 Cesium3DTileStyle. */
export function rampStyle(attrName: string, range: [number, number], palette: string[] = DEFAULT_RAMP): Cesium3DTileStyle {
  if (!palette.length) throw new Error('rampStyle: palette must not be empty');
  const [min, max] = range;
  const span = max - min || 1;
  const conditions: [string, string][] = [];
  for (let k = 0; k < palette.length; k++) {
    const hi = min + (span * (k + 1)) / palette.length;
    conditions.push([`\${${attrName}} <= ${hi}`, `color('${palette[k]}')`]);
  }
  conditions.push(['true', `color('${palette[palette.length - 1]}')`]);
  return new Cesium3DTileStyle({ color: { conditions } });
}
