// scripts/bench/serve-copc.ts — 단일 COPC 파일을 HTTP Range 로 서빙(로컬 IO 결정화용).
import { createServer } from 'node:http';
import { createReadStream, statSync } from 'node:fs';

export async function startCopcServer(
  filePath: string,
  port = 0, // 0 = OS 할당
): Promise<{ url: string; close: () => Promise<void> }> {
  const size = statSync(filePath).size;
  const server = createServer((req, res) => {
    if (req.url !== '/copc') { res.writeHead(404); res.end('not found'); return; }
    const range = req.headers.range;
    if (range) {
      const m = /bytes=(\d+)-(\d+)?/.exec(range);
      const start = m ? Number(m[1]) : 0;
      const end = m && m[2] ? Number(m[2]) : size - 1;
      res.writeHead(206, {
        'Content-Range': `bytes ${start}-${end}/${size}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': end - start + 1,
        'Content-Type': 'application/octet-stream',
      });
      createReadStream(filePath, { start, end }).pipe(res);
    } else {
      res.writeHead(200, { 'Content-Length': size, 'Accept-Ranges': 'bytes' });
      createReadStream(filePath).pipe(res);
    }
  });
  await new Promise<void>((r) => server.listen(port, r));
  const addr = server.address();
  const p = typeof addr === 'object' && addr ? addr.port : port;
  return {
    url: `http://localhost:${p}/copc`,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}
