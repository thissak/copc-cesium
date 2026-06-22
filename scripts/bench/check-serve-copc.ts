// scripts/bench/check-serve-copc.ts
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startCopcServer } from './serve-copc';

function assert(c: boolean, m: string) { if (!c) { console.log('FAIL ' + m); process.exit(1); } console.log('ok: ' + m); }

const dir = mkdtempSync(join(tmpdir(), 'copcsrv-'));
const f = join(dir, 'x.bin');
writeFileSync(f, Uint8Array.from([0,1,2,3,4,5,6,7,8,9]));

const srv = await startCopcServer(f);
const res = await fetch(srv.url, { headers: { Range: 'bytes=2-4' } });
assert(res.status === 206, 'range 요청은 206');
const buf = new Uint8Array(await res.arrayBuffer());
assert(JSON.stringify([...buf]) === JSON.stringify([2,3,4]), 'range 바이트 정확(2-4)');
assert(res.headers.get('content-range') === 'bytes 2-4/10', 'Content-Range 헤더 정확');
await srv.close();
console.log('SERVE PASS ✅');
