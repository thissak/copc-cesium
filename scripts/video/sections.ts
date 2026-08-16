// 출품 시연영상 구성 — 나레이션·자막·화면 소스의 단일 소유처.
// 편집은 이 파일만 고치면 된다. 타이밍은 나레이션 길이가 결정하고 build.ts 가 화면을 거기에 맞춘다.
//
// 수치 규칙: 모든 숫자는 실측. 근거 없는 우위 주장(특히 타 엔진 대비 성능)은 넣지 않는다.
// docs/bench/fair-compare-*.md 의 Eptium 비교는 "유효성 게이트 FAIL → verdict 신뢰불가" 이므로 인용 금지.

export type Visual =
  | { kind: 'clip'; src: string; from?: number } // raw 클립 (from 초부터)
  | { kind: 'card'; card: CardId }; // HTML 로 렌더하는 정지 카드

export type CardId = 'title' | 'code-api' | 'arch' | 'metrics' | 'outro';

export interface Section {
  id: string;
  /** 나레이션 원문. 이 길이가 곧 구간 길이가 된다. */
  narration: string;
  visual: Visual;
  /** 번인 자막 — 나레이션을 짧게 끊은 것. 구간 길이를 균등 분할해 표시. */
  subtitles: string[];
  /** 화면 우상단 강조 태그 (없으면 생략). */
  tags?: string[];
}

export const SECTIONS: Section[] = [
  {
    id: 's1-problem',
    narration:
      '라이다 점군을 웹 지도에 올리려면, 보통 원본을 3D 타일즈로 미리 변환해야 합니다. ' +
      '변환에는 시간이 들고, 같은 데이터를 두 벌로 저장해야 하며, 원본이 갱신될 때마다 다시 돌려야 합니다.',
    visual: { kind: 'card', card: 'title' },
    subtitles: [
      '점군을 웹에 올리려면 보통 3D Tiles로 미리 변환해야 한다',
      '변환 시간 · 중복 저장 · 갱신마다 재실행',
    ],
  },
  {
    id: 's2-copc',
    narration:
      '그런데 COPC는 이미 클라우드에 최적화된 옥트리입니다. HTTP 범위 요청으로 필요한 부분만 읽을 수 있습니다. ' +
      '변환 단계 자체를 없앨 수 있다는 뜻입니다.',
    visual: { kind: 'clip', src: 'autzen-orbit-rgb.mp4', from: 0 },
    subtitles: ['COPC = 이미 옥트리 + HTTP Range 접근', '변환 단계를 없앨 수 있다'],
    tags: ['Autzen · 77MB COPC'],
  },
  {
    id: 's3-api',
    // "기존 코드와 도구가 그대로 동작" 은 과장이라 좁혔다 — customShader 는 실제로 깨진다
    // (CHANGELOG 2026-08-16 [decision] customShader 패스스루 미채택: 셰이더 컴파일 실패 → 렌더 정지).
    // 실측으로 확인된 범위인 스타일·피킹만 주장한다.
    narration:
      'copc-cesium은 COPC 파일을 표준 세슘 3D 타일셋으로 그대로 노출합니다. ' +
      '한 줄이면 됩니다. 반환값이 세슘의 표준 타입이라, 세슘의 스타일과 피킹이 그대로 동작합니다.',
    visual: { kind: 'card', card: 'code-api' },
    subtitles: ['CopcTileset.fromUrl() 한 줄', '반환값 = 표준 Cesium3DTileset'],
  },
  {
    id: 's4-style',
    narration:
      '표준 타입이라는 말은 구체적인 이득입니다. 세슘의 스타일 언어가 그대로 먹습니다. ' +
      '여기서는 분류 코드별로 색을 입혔습니다. 엘오디와 컬링, 지피유 메모리 관리도 전부 세슘이 원래 하던 방식 그대로입니다.',
    visual: { kind: 'clip', src: 'autzen-orbit-class.mp4', from: 0 },
    subtitles: [
      'Cesium3DTileStyle 이 그대로 적용된다',
      '분류 코드별 색 · 지반 · 식생 · 건물',
      'LOD · 컬링 · GPU 메모리 = Cesium 그대로',
    ],
    tags: ['Classification 스타일'],
  },
  {
    // 경쟁작 대비 구조적 우위 — 사전 변환된 pnts 만 가진 엔진은 원본 점에 접근할 수 없다.
    id: 's4b-pick',
    narration:
      '점을 클릭하면 그 점의 좌표와 라스 속성이 그대로 나옵니다. ' +
      '화면에 그려진 픽셀이 아니라, 옥트리에서 가장 깊은 노드를 그때 받아 원본 점을 찾아 돌려줍니다.',
    visual: { kind: 'clip', src: 'autzen-pick.webm' },
    // 태그를 두지 않는다 — pick 패널이 우상단이라 겹친다.
    subtitles: ['클릭 → 좌표 · 분류 · 강도 · 리턴', '원본 점을 옥트리에서 직접 조회'],
  },
  {
    id: 's5-arch',
    narration:
      '동작 원리는 이렇습니다. COPC의 옥트리를 3D 타일즈 트리로 노출하면, 어떤 노드를 언제 가져올지는 세슘이 판단합니다. ' +
      '세슘이 타일을 요청하면 서비스워커가 그 요청을 가로채고, 그 노드만 웹 워커에서 디코딩해 돌려줍니다.',
    visual: { kind: 'card', card: 'arch' },
    subtitles: [
      'COPC 옥트리 → 동적 3D Tiles 트리',
      'Cesium이 노드를 선택·요청',
      'Service Worker가 가로채 Web Worker가 디코드',
    ],
  },
  {
    id: 's6-stream',
    narration:
      '실제로 줌인해 보겠습니다. 지금 보시는 화면은 실시간 녹화입니다. ' +
      '가까이 갈수록 필요한 노드만 추가로 받아 디테일이 채워집니다. 전체 파일을 내려받지 않습니다.',
    visual: { kind: 'clip', src: 'autzen-dive-lod.webm', from: 1.5 },
    subtitles: ['실시간 녹화 · 배속 없음', '가까이 갈수록 필요한 노드만 추가 요청', '전체 파일을 내려받지 않는다'],
    tags: ['실시간 · 배속 없음'],
  },
  {
    id: 's7-large',
    narration:
      '큰 데이터에서도 같습니다. 소파이 스타디움, 1.9 기가바이트 원본입니다. 사전 변환 없이 원본 그대로 열었습니다.',
    visual: { kind: 'clip', src: 'sofi-orbit.mp4', from: 2 },
    subtitles: ['SoFi Stadium · 1.9GB 원본', '사전 변환 0단계'],
    tags: ['SoFi Stadium · 1.9GB'],
  },
  {
    id: 's8-large-stream',
    narration:
      '이 데이터에는 색 정보가 없어 고도로 색을 입혔습니다. 붉은 부분이 경기장 지붕입니다. ' +
      '기가바이트급에서도 보이는 만큼만 스트리밍합니다.',
    visual: { kind: 'clip', src: 'sofi-dive-lod.webm', from: 2 },
    subtitles: ['RGB 없는 데이터 → 고도 색', '붉은 부분 = 경기장 지붕', 'GB급에서도 보이는 만큼만'],
    tags: ['고도 색 · 실시간'],
  },
  {
    id: 's9-verify',
    narration:
      '주장은 측정으로 뒷받침합니다. 오프라인 검증 아홉 항목, 실데이터 통합 검증 아홉 항목이 모두 통과합니다. ' +
      '좌표 정합은 세슘 기준으로 나노미터 수준까지 일치합니다.',
    visual: { kind: 'card', card: 'title' }, // 실제 화면은 build.ts 의 터미널 클립으로 대체된다,
    subtitles: ['오프라인 9/9 · 실데이터 통합 9/9', 'ECEF 좌표 오차 최대 1.4 × 10⁻⁹ m'],
  },
  {
    // 전부 우리 코드의 before/after 자체 측정 — 타 엔진 인용이 아니라 반박 여지가 없다.
    id: 's9b-metrics',
    narration:
      '성능도 추측이 아니라 측정으로 잡았습니다. 요청 병합으로 S3 왕복을 예순한 번에서 여섯 번으로, ' +
      '좌표 재투영은 쉰네 배 빠르게, 깊은 줌은 열여섯 프레임에서 여든아홉 프레임으로 올렸습니다. ' +
      '8.9 기가바이트 데이터로 90초 스트레스를 걸어도 메모리가 평탄하게 유지됩니다.',
    visual: { kind: 'card', card: 'metrics' },
    subtitles: [
      'S3 range 왕복 61 → 6',
      '좌표 재투영 54배',
      '깊은 줌 16 → 89 fps',
      'Cahokia 8.9GB · 메모리 plateau',
    ],
  },
  {
    id: 's10-outro',
    narration:
      'copc-cesium. 아파치 2.0 라이선스로 공개돼 있고, 라이브 데모에서 바로 만져보실 수 있습니다.',
    visual: { kind: 'card', card: 'outro' },
    subtitles: ['copc-cesium.vercel.app · Apache-2.0'],
  },
];
