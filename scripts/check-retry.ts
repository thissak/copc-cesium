// 복원력 결정적 검증: httpGetterWithRetry 의 재시도/분류/소진을 mock fetch 로 확인.
// 실행: npx tsx scripts/check-retry.ts
import { httpGetterWithRetry } from '../src/copc-core';

type Step = { throw?: 'network' | 'bug'; status?: number };

function mockFetch(plan: Step[]) {
  let calls = 0;
  const fn = async () => {
    const step = plan[Math.min(calls, plan.length - 1)];
    calls++;
    // 'network' = 실제 fetch 실패 메시지(is-network-error 인식 → 재시도 대상)
    if (step.throw === 'network') throw new TypeError('fetch failed');
    // 'bug' = 비네트워크 TypeError(프로그래밍 버그) → 재시도 안 함(버그를 가리지 않음)
    if (step.throw === 'bug') throw new TypeError("cannot read 'x' of undefined");
    if (step.status && step.status !== 200) return new Response('err', { status: step.status });
    return new Response(new Uint8Array([1, 2, 3]));
  };
  return { fn: fn as unknown as typeof fetch, calls: () => calls };
}

async function run(name: string, plan: Step[], expect: { ok: boolean; calls: number }) {
  const m = mockFetch(plan);
  const getter = httpGetterWithRetry('http://mock/x', m.fn);
  let ok = false;
  let err: string | undefined;
  try {
    const bytes = await getter(0, 3);
    ok = bytes instanceof Uint8Array && bytes.length === 3;
  } catch (e) {
    err = (e as Error).message;
  }
  const pass = ok === expect.ok && m.calls() === expect.calls;
  console.log(
    `${pass ? 'PASS' : 'FAIL'}  ${name}: ok=${ok} calls=${m.calls()} (기대 ok=${expect.ok} calls=${expect.calls})` +
      (err ? `  err=${err.slice(0, 36)}` : ''),
  );
  return pass;
}

let all = true;
all = (await run('성공 1회', [{ status: 200 }], { ok: true, calls: 1 })) && all;
all = (await run('네트워크 2회 실패→성공', [{ throw: 'network' }, { throw: 'network' }, { status: 200 }], { ok: true, calls: 3 })) && all;
all = (await run('503 2회→성공', [{ status: 503 }, { status: 503 }, { status: 200 }], { ok: true, calls: 3 })) && all;
all = (await run('404 즉시실패(재시도X)', [{ status: 404 }], { ok: false, calls: 1 })) && all;
all = (await run('416 즉시실패(재시도X)', [{ status: 416 }], { ok: false, calls: 1 })) && all;
all = (await run('지속 503→소진 후 실패', [{ status: 503 }], { ok: false, calls: 4 })) && all;
all = (await run('버그 TypeError→즉시실패(가리지 않음)', [{ throw: 'bug' }], { ok: false, calls: 1 })) && all;

// 타임아웃: 응답 없는 fetch → AbortSignal.timeout 으로 중단·재시도·소진 후 표면화(무한 대기 X)
{
  // AbortSignal.timeout 은 unref'd 타이머 → 격리된 Node 빈 루프선 안 깬다. 실제 앱엔 다른 ref
  // 작업이 있어 정상 발화하지만, 테스트에선 keep-alive 로 루프를 살려 타이머가 발화하게 한다.
  const keepAlive = setInterval(() => {}, 1000);
  let calls = 0;
  const hanging = ((_u: string, opts?: { signal?: AbortSignal }) => {
    calls++;
    return new Promise<Response>((_res, rej) => {
      opts?.signal?.addEventListener('abort', () => rej(opts.signal?.reason ?? new Error('aborted')));
    });
  }) as unknown as typeof fetch;
  const getter = httpGetterWithRetry('http://mock/x', hanging, 50); // 50ms 타임아웃
  let timedOut = false;
  try {
    await getter(0, 3);
  } catch {
    timedOut = true;
  }
  clearInterval(keepAlive);
  const pass = timedOut && calls === 4; // 4 시도 모두 타임아웃 후 소진 → 명확히 실패
  console.log(`${pass ? 'PASS' : 'FAIL'}  타임아웃→재시도→표면화: timedOut=${timedOut} calls=${calls} (기대 true/4)`);
  all = pass && all;
}

console.log(all ? '\nRETRY PASS ✅  재시도/분류/소진/타임아웃 모두 정확' : '\nRETRY FAIL ❌');
process.exit(all ? 0 : 1);
