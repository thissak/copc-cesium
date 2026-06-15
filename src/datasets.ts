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
];
