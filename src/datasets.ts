// 검증된 공개 COPC 데이터셋.
// 2026-06-16 curl로 확인: HTTP Range 206 + Accept-Ranges: bytes + Access-Control-Allow-Origin: *
// → copc.js Getter.http 가 브라우저에서 바로 동작.

export interface CopcDataset {
  id: string;
  label: string;
  url: string;
  bytes: number;
  note: string;
}

export const DATASETS: CopcDataset[] = [
  {
    id: 'autzen',
    label: 'Autzen (소형·정확성)',
    url: 'https://s3.amazonaws.com/hobu-lidar/autzen-classified.copc.laz',
    bytes: 81_123_042,
    note: 'Oregon, ~77MB. T0 정확성 검증용',
  },
  {
    id: 'millsite',
    label: 'Millsite (대형·벽)',
    url: 'https://s3.amazonaws.com/data.entwine.io/millsite.copc.laz',
    bytes: 1_872_403_716,
    note: '~1.74GB. 성능 벽 찾기용',
  },
  {
    id: 'sofi',
    label: 'SoFi Stadium (대형·벽)',
    url: 'https://hobu-lidar.s3.amazonaws.com/sofi.copc.laz',
    bytes: 2_029_696_615,
    note: '~1.9GB. 성능 벽 찾기용',
  },
  {
    id: 'fema_pr',
    label: 'FEMA Puerto Rico (광역·항공)',
    url: 'https://s3.amazonaws.com/hobu-lidar/2018_FEMA_PR_new_untwine.copc.laz',
    bytes: 980_741_036,
    note: '~980MB. 항공 라이다 광역 footprint → 수평 광역 LOD 스트리밍 검증',
  },
  {
    id: 'cahokia',
    label: 'Cahokia MLS (8.9GB·최대)',
    url: 'https://s3.amazonaws.com/hobu-lidar/Cahokia-20231016-MLS-NGA.copc.laz',
    bytes: 8_878_777_180,
    note: '~8.9GB. 최대 단일 COPC. 절대 스케일·메타 누적 갭 스트레스',
  },
];
