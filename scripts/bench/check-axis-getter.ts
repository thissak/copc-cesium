import { makeTimedGetter } from './axis-getter';

function assert(c: boolean, m: string) { if (!c) { console.log('FAIL ' + m); process.exit(1); } console.log('ok: ' + m); }

// 200ms 헤더 지연 mock fetch — IO ms 가 지연을 반영해야.
const slow = (async (_u: unknown, o: { signal?: AbortSignal }) => {
  await new Promise((r) => setTimeout(r, 200));
  return new Response(Uint8Array.from([9, 9, 9]), { status: 206 });
}) as unknown as typeof fetch;

const { getter, io } = makeTimedGetter('http://mock/copc', slow);
const bytes = await getter(0, 3);
assert(bytes.length === 3, 'getter 가 바이트 반환');
assert(io.length === 1, 'io 1건 기록');
assert(io[0].ms >= 190, `io ms 가 지연 반영(>=190, got ${io[0].ms.toFixed(0)})`);
assert(io[0].bytes === 3, 'io bytes=3');
const empty = await getter(5, 5);
assert(empty.length === 0 && io.length === 1, 'end<=begin 은 빈 배열·기록 없음');
console.log('GETTER PASS ✅');
