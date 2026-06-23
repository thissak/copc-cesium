// 취소 전파 결정적 검증 (이슈 #20).
// Cesium 이 더 이상 필요 없는 타일의 요청을 취소해도, 우리 파이프라인은 그 취소를 *하류*(SW→worker→
// copc-core fetch)로 전파하지 못한다 → 버려진 타일의 range fetch/decode 가 끝까지 돌아 동시성 슬롯·워커 점유.
// 가장 하류(=가장 끊기 어려운) 지점인 copc-core 의 range getter 가 "외부 취소 신호"를 받아 in-flight fetch 를
// 중단할 수 있어야 한다. 현재(수정 전)는 그 수단이 없어 외부 취소가 무시된다.
//
// 실행: npx tsx scripts/check-cancel.ts
// 기대: 수정 전 FAIL(RED) — getter 가 외부 취소를 무시. 수정 후 PASS(GREEN).
import { httpGetterWithRetry } from '../src/copc-core';

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

// getter 를 외부 signal 과 함께 호출(수정 후 시그니처). 현재는 3번째 인자가 무시됨 → 런타임 캐스트로 호출.
type CancelableGetter = (begin: number, end: number, signal?: AbortSignal) => Promise<Uint8Array>;

let all = true;

// ── 시나리오 1: 외부 취소 → in-flight range fetch 즉시 중단 ──
// 응답 없이 매달리는 fetch(긴 내부 timeout) → 유일한 종료 수단은 "외부 취소" 여야 한다.
{
  const keepAlive = setInterval(() => {}, 1000); // Node 빈 루프가 타이머 전에 죽지 않게
  let received: AbortSignal | undefined;
  const hanging = ((_u: string, opts?: { signal?: AbortSignal }) => {
    received = opts?.signal;
    return new Promise<Response>((_res, rej) => {
      opts?.signal?.addEventListener('abort', () => rej(opts!.signal!.reason ?? new Error('aborted')));
    });
  }) as unknown as typeof fetch;

  const getter = httpGetterWithRetry('http://mock/x', hanging, 60000) as unknown as CancelableGetter; // 60s 내부 timeout
  const ext = new AbortController();
  const p = getter(0, 3, ext.signal);
  await delay(20); // fetch 진입 보장
  ext.abort(new Error('consumer cancelled (tile no longer needed)'));

  const outcome = await Promise.race([
    p.then(() => 'resolved', () => 'rejected'),
    delay(300).then(() => 'pending'),
  ]);
  // fetch 가 실제로 받은 signal 이 외부 취소로 끊겼는지(=취소가 하류 fetch 까지 전파)
  const fetchAborted = !!received?.aborted;
  clearInterval(keepAlive);

  const pass = outcome === 'rejected' && fetchAborted;
  console.log(
    `${pass ? 'PASS' : 'FAIL'}  외부취소→in-flight fetch 중단: outcome=${outcome} fetchSignalAborted=${fetchAborted} (기대 rejected/true)`,
  );
  all = pass && all;
}

// ── 시나리오 2: 취소 후 추가 재시도 없음 ──
// 재시도 가능한 실패(네트워크) 백오프 대기 중 외부 취소 → 더 이상 시도하지 않아야 한다(좀비 재시도 폭풍 차단).
{
  const keepAlive = setInterval(() => {}, 1000);
  let calls = 0;
  const flaky = (() => {
    calls++;
    return Promise.reject(new TypeError('fetch failed')); // is-network-error → 재시도 대상
  }) as unknown as typeof fetch;

  const getter = httpGetterWithRetry('http://mock/x', flaky, 8000) as unknown as CancelableGetter;
  const ext = new AbortController();
  const p = getter(0, 3, ext.signal);
  await delay(50); // 1회 실패 후 backoff(min 300ms) 대기 중에 취소
  ext.abort();

  let rejected = false;
  try {
    await p;
  } catch {
    rejected = true;
  }
  await delay(400); // 혹시 남은 재시도가 더 발생하는지 관측 창
  clearInterval(keepAlive);

  const pass = rejected && calls < 4; // 수정 전: 외부취소 무시 → 4회 소진(FAIL). 수정 후: 취소 시점에 중단(calls≈1)
  console.log(`${pass ? 'PASS' : 'FAIL'}  취소 후 재시도 중단: calls=${calls} rejected=${rejected} (기대 calls<4)`);
  all = pass && all;
}

console.log(all ? '\nCANCEL PASS ✅  외부 취소가 하류 fetch 까지 전파됨' : '\nCANCEL FAIL ❌  외부 취소가 무시됨(취소 미전파 — 이슈 #20)');
process.exit(all ? 0 : 1);
