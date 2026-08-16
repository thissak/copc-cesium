// 복원력 결정적 검증: httpGetterWithRetry 의 재시도/분류/소진을 mock fetch 로 확인.
// 실행: npx tsx scripts/check-retry.ts
import { httpGetterWithRetry } from '../src/copc-core';

/**
 * `body` 는 응답 바디 길이(요청은 항상 3B). `total` 은 Content-Range 의 파일 크기.
 * 기본은 **계약을 지키는 range 서버**: 206 + 정확한 길이 + Content-Range.
 */
type Step = { throw?: 'network' | 'bug'; status?: number; body?: number; total?: number; noContentRange?: boolean };

function mockFetch(plan: Step[]) {
  let calls = 0;
  const fn = async () => {
    const step = plan[Math.min(calls, plan.length - 1)];
    calls++;
    // 'network' = 실제 fetch 실패 메시지(is-network-error 인식 → 재시도 대상)
    if (step.throw === 'network') throw new TypeError('fetch failed');
    // 'bug' = 비네트워크 TypeError(프로그래밍 버그) → 재시도 안 함(버그를 가리지 않음)
    if (step.throw === 'bug') throw new TypeError("cannot read 'x' of undefined");
    const status = step.status ?? 206;
    if (status >= 400) return new Response('err', { status });
    const len = step.body ?? 3;
    const total = step.total ?? 1000;
    const headers = step.noContentRange ? {} : { 'Content-Range': `bytes 0-${Math.max(0, len - 1)}/${total}` };
    return new Response(new Uint8Array(len), { status, headers });
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
all = (await run('성공 1회', [{}], { ok: true, calls: 1 })) && all;
all = (await run('네트워크 2회 실패→성공', [{ throw: 'network' }, { throw: 'network' }, {}], { ok: true, calls: 3 })) && all;
all = (await run('503 2회→성공', [{ status: 503 }, { status: 503 }, {}], { ok: true, calls: 3 })) && all;
all = (await run('404 즉시실패(재시도X)', [{ status: 404 }], { ok: false, calls: 1 })) && all;
all = (await run('416 즉시실패(재시도X)', [{ status: 416 }], { ok: false, calls: 1 })) && all;
all = (await run('지속 503→소진 후 실패', [{ status: 503 }], { ok: false, calls: 4 })) && all;
all = (await run('버그 TypeError→즉시실패(가리지 않음)', [{ throw: 'bug' }], { ok: false, calls: 1 })) && all;

// ── range 응답 계약 (스트레스에서 발견한 조용한 오염 경로) ──
// 상태가 2xx 라도 "요청한 바이트"가 아니면 laz-perf 가 쓰레기를 디코드해 예외 없이 렌더된다.
all = (await run('200(Range 무시)→즉시실패(재시도X)', [{ status: 200 }], { ok: false, calls: 1 })) && all;
all = (await run('206 인데 0바이트→재시도 후 실패', [{ body: 0 }], { ok: false, calls: 4 })) && all;
all = (await run('206 인데 절반→재시도 후 성공', [{ body: 1 }, { body: 1 }, {}], { ok: true, calls: 3 })) && all;
all = (await run('206 인데 Content-Range 없음+짧음→실패', [{ body: 2, noContentRange: true }], { ok: false, calls: 4 })) && all;
all = (await run('206 인데 초과 반환→즉시실패(재시도X)', [{ body: 10 }], { ok: false, calls: 1 })) && all;
// 파일 끝 클램프는 정당 — 헤더 프로브가 파일 크기보다 큰 범위를 요청하는 정상 경로다.
{
  const m = mockFetch([{ body: 2, total: 2 }]);
  const getter = httpGetterWithRetry('http://mock/x', m.fn);
  let bytes = -1;
  try { bytes = (await getter(0, 3)).length; } catch { /* 실패는 아래 판정에서 걸린다 */ }
  const pass = bytes === 2 && m.calls() === 1;
  console.log(`${pass ? 'PASS' : 'FAIL'}  EOF 클램프(2/2B)는 정상 통과: bytes=${bytes} calls=${m.calls()}`);
  all = pass && all;
}

// 첫 정상 응답에서 파일 크기(total)를 학습하면, 이후 "총=begin+received" 로 거짓말하는 클램프를 잡는다.
{
  const m = mockFetch([{}, { body: 2, total: 2 }]);
  const getter = httpGetterWithRetry('http://mock/x', m.fn);
  const first = (await getter(0, 3)).length; // 1000B 파일임을 학습
  let failed = false;
  try { await getter(0, 3); } catch { failed = true; }
  const pass = first === 3 && failed && m.calls() === 5; // 거짓 클램프 = 잘림 → 재시도 소진(1+4)
  console.log(`${pass ? 'PASS' : 'FAIL'}  거짓 total 클램프는 학습된 크기로 차단: failed=${failed} calls=${m.calls()}`);
  all = pass && all;
}

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
