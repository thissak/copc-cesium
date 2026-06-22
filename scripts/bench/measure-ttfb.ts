// 이슈 #14 측정(코드 동결·측정 먼저): range 읽기 시간이 TTFB(pre-header: 큐+연결+서버 응답시작)에서
// 오나, body(헤더 후 바이트 전송)에서 오나를 분해한다. dual-review가 제기한 핵심 질문 —
// "느린 망 brittle의 실제 병목이 본문 throughput인가(=idle 타임아웃이 맞는 레버), 아니면
//  pre-header인가(=idle은 헛다리, 레버는 동시성/연결/예산)?" — 에 데이터로 답한다.
//
// 방법: copc.js 의 실제 read 경로(header/hierarchy/node point-data range)를 계측 getter로 돌려
//   per-range { ttfbMs = dispatch→헤더수신, bodyMs = 헤더→마지막바이트 } 를 기록. 프로덕션 코드 무변경.
//   (S3 가 Timing-Allow-Origin 미전송이라 PerformanceResourceTiming 분해 불가 → 직접 계측이 유일.)
// 실행: npx tsx scripts/bench/measure-ttfb.ts [url|ds] [nodeSample] [concurrency]
import { Copc } from 'copc';

const DS: Record<string, string> = {
  autzen: 'https://s3.amazonaws.com/hobu-lidar/autzen-classified.copc.laz',
  millsite: 'https://s3.amazonaws.com/hobu-lidar/millsite.copc.laz',
  sofi: 'https://hobu-lidar.s3.amazonaws.com/sofi.copc.laz',
};
const arg = process.argv[2] || 'millsite';
const url = DS[arg] || arg;
const nodeSample = Number(process.argv[3] || '200'); // point-data range 표본 수(깊이 오름차순)
const concurrency = Number(process.argv[4] || '6'); // 콘텐츠 host 동시성(profile-io throttle=6과 동형)

type Rec = { kind: 'header' | 'hier' | 'point'; ttfb: number; body: number; bytes: number };
const recs: Rec[] = [];

// 계측 range getter — httpGetterWithRetry 의 fetch→헤더→스트림 read 경로를 그대로 따라하되 시간만 쪼갠다.
function timedGetter(kindFor: (begin: number) => Rec['kind']) {
  return async (begin: number, end: number): Promise<Uint8Array> => {
    if (end <= begin) return new Uint8Array(0);
    const kind = kindFor(begin);
    const tReq = performance.now();
    const res = await fetch(url, { headers: { Range: `bytes=${begin}-${end - 1}` } });
    const tHdr = performance.now(); // undici: fetch 는 헤더 수신 시 resolve → tHdr-tReq ≈ TTFB(+큐)
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${begin}-${end}`);
    if (!res.body) {
      const buf = new Uint8Array(await res.arrayBuffer());
      recs.push({ kind, ttfb: tHdr - tReq, body: performance.now() - tHdr, bytes: buf.length });
      return buf;
    }
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      total += value.length;
    }
    const tEnd = performance.now();
    recs.push({ kind, ttfb: tHdr - tReq, body: tEnd - tHdr, bytes: total });
    const out = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) { out.set(c, off); off += c.length; }
    return out;
  };
}

function pct(arr: number[], p: number): number {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  return +s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))].toFixed(1);
}
const sum = (a: number[]) => a.reduce((x, y) => x + y, 0);

async function pool<T>(items: T[], limit: number, fn: (t: T) => Promise<void>): Promise<void> {
  let idx = 0;
  const worker = async () => {
    for (;;) {
      const i = idx++;
      if (i >= items.length) break;
      try { await fn(items[i]); } catch { /* 측정: 실패는 건너뜀(throttle/일시) */ }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length || 1) }, worker));
}

async function main() {
  console.log(`\n=== #14 TTFB vs body 분해 측정 (${arg}) ===`);
  console.log(`url=${url}\nnodeSample=${nodeSample} concurrency=${concurrency}\n`);

  // header + hierarchy 는 단일 경로(계측 kind 구분).
  const headerGetter = timedGetter(() => 'header');
  const copc = await Copc.create(headerGetter);
  const hierGetter = timedGetter(() => 'hier');
  const { nodes } = await Copc.loadHierarchyPage(hierGetter, copc.info.rootHierarchyPage);

  // 깊이 오름차순(naive deep-load 순서와 동형) 노드 표본의 point-data range 를 동시성 cap 으로 읽음.
  const keys = Object.keys(nodes)
    .filter((k) => nodes[k])
    .sort((a, b) => Number(a.split('-')[0]) - Number(b.split('-')[0]))
    .slice(0, nodeSample);
  const pointGetter = timedGetter(() => 'point');
  await pool(keys, concurrency, async (k) => {
    const n = nodes[k]!;
    if (!n.pointDataLength) return;
    await pointGetter(n.pointDataOffset, n.pointDataOffset + n.pointDataLength);
  });

  const point = recs.filter((r) => r.kind === 'point');
  const ttfb = point.map((r) => r.ttfb);
  const body = point.map((r) => r.body);
  const bytes = point.map((r) => r.bytes);
  const sumTtfb = sum(ttfb), sumBody = sum(body);
  const share = sumTtfb + sumBody > 0 ? (sumTtfb / (sumTtfb + sumBody)) * 100 : 0;

  console.log(`point-data range 읽기: ${point.length}개  (concurrency=${concurrency})`);
  console.log(`  TTFB(dispatch→헤더) ms : p50=${pct(ttfb, 50)} p95=${pct(ttfb, 95)} max=${Math.max(...ttfb, 0).toFixed(0)}  Σ=${sumTtfb.toFixed(0)}`);
  console.log(`  body(헤더→끝)      ms : p50=${pct(body, 50)} p95=${pct(body, 95)} max=${Math.max(...body, 0).toFixed(0)}  Σ=${sumBody.toFixed(0)}`);
  console.log(`  bytes/range          : p50=${(pct(bytes, 50) / 1024).toFixed(1)}KB p95=${(pct(bytes, 95) / 1024).toFixed(1)}KB  Σ=${(sum(bytes) / 1e6).toFixed(2)}MB`);
  console.log(`\n--- 결론 신호 ---`);
  console.log(`TTFB가 range 시간 차지 : ${share.toFixed(0)}%   (>70% 면 pre-header 지배 → idle(body) 레버 헛다리, 레버=동시성/연결/예산)`);
  console.log(`                          (<40% 면 body 지배 → idle 타임아웃이 맞는 레버)`);
  console.log(`header/hier 읽기 참고   : header ${recs.filter(r => r.kind === 'header').length}개, hier ${recs.filter(r => r.kind === 'hier').length}개`);
  console.log(`\n⚠️ 측정 한계: 현재 S3 비-throttle 상태. 이 split 은 정상망 baseline. S3 throttle 은 응답시작 지연(=TTFB)을`);
  console.log(`   부풀리므로, baseline 이 이미 TTFB 지배면 throttle 시 더 심해진다(보수적 신호). throttle 실측은 follow-up.`);
}
main().catch((e) => { console.error('fatal', e); process.exit(1); });
