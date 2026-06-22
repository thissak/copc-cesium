// scripts/bench/axis-getter.ts — copc.js getter 를 감싸 fetch(Range) 총 ms·바이트를 기록(IO 축).
export type IoRec = { ms: number; bytes: number };

export function makeTimedGetter(url: string, fetchImpl: typeof fetch = fetch) {
  const io: IoRec[] = [];
  const getter = async (begin: number, end: number): Promise<Uint8Array> => {
    if (end <= begin) return new Uint8Array(0);
    const t0 = performance.now();
    const res = await fetchImpl(url, { headers: { Range: `bytes=${begin}-${end - 1}` } });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${begin}-${end}`);
    const buf = new Uint8Array(await res.arrayBuffer());
    io.push({ ms: performance.now() - t0, bytes: buf.length });
    return buf;
  };
  return { getter, io };
}
