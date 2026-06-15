// 데이터 축(①fetch ②decode ③reproject) 성능 스윕 — 브라우저 없이 헤드리스.
// 점 예산을 키워가며 로드 시간·처리량·메모리를 측정해 "벽"의 위치를 곡선으로 본다. (C2 데이터 축)
// 실행: npm run sweep  [url]  [budget,budget,...]

import { loadCopcPoints } from '../src/copc-core';

const URL = process.argv[2] ?? 'https://s3.amazonaws.com/hobu-lidar/autzen-classified.copc.laz';
const budgets = (process.argv[3]?.split(',').map(Number)) ?? [
  50_000, 250_000, 1_000_000, 2_500_000, 5_000_000, 11_000_000,
];

const pad = (s: string | number, n: number) => String(s).padStart(n);
const MB = (bytes: number) => (bytes / 1048576).toFixed(1);

console.log(`sweep: ${URL}\n`);
console.log(
  [pad('budget', 11), pad('points', 11), pad('loadMs', 8), pad('ms/1M', 7), pad('arrayMB', 9), pad('rssMB', 8)].join(''),
);
console.log('-'.repeat(54));

for (const b of budgets) {
  const t0 = performance.now();
  let r;
  try {
    r = await loadCopcPoints(URL, b);
  } catch (e) {
    console.log(`${pad(b, 11)}   ERROR: ${(e as Error)?.message ?? e}`);
    break; // 벽에 부딪힘
  }
  const ms = performance.now() - t0;
  const perM = ms / (r.pointCount / 1e6 || 1);
  // 점 배열 footprint: lonLatH(3) + zVals(1) = 4 number × 8 byte = 32 byte/pt
  const arrayBytes = r.pointCount * 32;
  const rss = process.memoryUsage().rss;
  console.log(
    [
      pad(b.toLocaleString(), 11),
      pad(r.pointCount.toLocaleString(), 11),
      pad(ms.toFixed(0), 8),
      pad(perM.toFixed(0), 7),
      pad(MB(arrayBytes), 9),
      pad(MB(rss), 8),
    ].join(''),
  );
}

console.log('\n해석: loadMs/메모리가 점 수에 선형이면 → 상한 없음(naive). 곡선이 꺾이거나 ERROR면 그 지점이 데이터축 벽.');
console.log('주의: rssMB는 프로세스 누적치(이전 로드 잔여 포함). arrayMB가 해당 로드의 순수 점 데이터 크기.');
