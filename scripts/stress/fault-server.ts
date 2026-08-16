// 결함 주입 HTTP Range 서버 — 로컬 COPC 파일을 서빙하되 모드별로 "나쁜 서버"를 흉내낸다.
//
// 목적: 우리 IO 계층(httpGetterWithRetry + copc.js + laz-perf)이 적대적/불량 서버 앞에서
//       (a) 명확히 실패하는가 (b) 조용히 쓰레기를 렌더하는가 (c) 영영 매달리는가 를 가른다.
//
// URL 형식: http://localhost:PORT/{mode}/copc[?from=N&to=M]
// 모드는 요청마다 독립 — 한 서버 인스턴스가 모든 모드를 동시에 서빙한다.
// from/to 는 결함을 적용할 파일 오프셋 창(기본 전체). 헤더·하이어라키는 정상 서빙하고
// **점데이터 구간만** 손상시키면 open 은 통과하고 디코드 경로가 노출된다.

import { createServer, type Server } from 'node:http';
import { openSync, readSync, statSync, closeSync } from 'node:fs';

export type FaultMode =
  | 'ok' // 통제군 — 정상 206
  | 'short' // 206 인데 본문이 요청 길이의 절반 (서버가 잘라 보냄)
  | 'zero' // 206 인데 본문 0바이트
  | 'shift' // 206 인데 요청 offset+1 부터 (미묘한 off-by-one 손상)
  | 'corrupt' // 206 정확한 길이인데 바이트가 XOR 0x5A (LAZ 청크 손상)
  | 'norange' // Range 헤더 무시 → 200 + 파일 전체 (Range 미지원 서버)
  | 'slow' // 정상이지만 20s 지연 (타임아웃 경로)
  | 'flaky' // 앞의 2회는 503, 그 뒤 정상 (p-retry 복구 경로)
  | 'always500' // 항상 500 (재시도 소진 경로)
  | 'always403'; // 항상 403 (비재시도 = 즉시 중단 경로)

export interface ServerStats {
  /** 모드별 요청 수 */
  hits: Record<string, number>;
  /** 모드별로 실제 내보낸 바이트 */
  bytes: Record<string, number>;
}

const HEADER_SAFE = 4096; // 이 범위는 corrupt 모드에서도 건드리지 않는다(헤더 파싱은 통과시켜 *이후* 실패를 본다)

export async function startFaultServer(
  filePath: string,
  port = 0,
): Promise<{
  base: string;
  size: number;
  url: (m: FaultMode, scope?: { from: number; to: number }) => string;
  stats: ServerStats;
  close: () => Promise<void>;
}> {
  const size = statSync(filePath).size;
  const fd = openSync(filePath, 'r');
  const stats: ServerStats = { hits: {}, bytes: {} };
  const flakyCount = new Map<string, number>();

  const read = (start: number, len: number): Buffer => {
    const clamped = Math.max(0, Math.min(len, size - start));
    const buf = Buffer.alloc(clamped);
    if (clamped > 0) readSync(fd, buf, 0, clamped, start);
    return buf;
  };

  const server: Server = createServer(async (req, res) => {
    // 브라우저(워커)에서도 쓰므로 CORS + Range preflight 를 연다.
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Range');
    res.setHeader('Access-Control-Expose-Headers', 'Content-Range, Content-Length, Accept-Ranges');
    if (req.method === 'OPTIONS') {
      res.writeHead(204).end();
      return;
    }
    const u = new URL(req.url ?? '/', 'http://x');
    const m = /^\/([a-z0-9]+)\/copc$/.exec(u.pathname);
    if (!m) {
      res.writeHead(404).end('not found');
      return;
    }
    const mode = m[1] as FaultMode;
    stats.hits[mode] = (stats.hits[mode] ?? 0) + 1;
    const from = Number(u.searchParams.get('from') ?? 0);
    const to = Number(u.searchParams.get('to') ?? Number.MAX_SAFE_INTEGER);

    const rangeHeader = req.headers.range;
    const rm = rangeHeader ? /bytes=(\d+)-(\d+)?/.exec(rangeHeader) : null;
    const start = rm ? Number(rm[1]) : 0;
    const end = rm && rm[2] ? Number(rm[2]) : size - 1;
    const wanted = end - start + 1;

    const send = (status: number, body: Buffer, headers: Record<string, string | number> = {}) => {
      stats.bytes[mode] = (stats.bytes[mode] ?? 0) + body.length;
      res.writeHead(status, { 'Content-Type': 'application/octet-stream', 'Accept-Ranges': 'bytes', ...headers });
      res.end(body);
    };
    const range206 = (body: Buffer, declaredLen = body.length) =>
      send(206, body, {
        'Content-Range': `bytes ${start}-${start + declaredLen - 1}/${size}`,
        'Content-Length': declaredLen,
      });

    // 결함 창 밖의 요청은 언제나 정상 서빙 (헤더·하이어라키를 살려 두는 용도).
    if (!(start >= from && start < to)) return range206(read(start, wanted));

    switch (mode) {
      case 'ok':
        return range206(read(start, wanted));
      case 'short': {
        // 본문은 절반만. Content-Length 도 그에 맞춰 정직하게 줄인다(= 서버가 range 를 클램프한 상황).
        const half = Math.max(1, Math.floor(wanted / 2));
        return range206(read(start, half));
      }
      case 'zero':
        return range206(Buffer.alloc(0), 0);
      case 'shift':
        return range206(read(start + 1, wanted));
      case 'corrupt': {
        const buf = read(start, wanted);
        for (let i = 0; i < buf.length; i++) if (start + i >= HEADER_SAFE) buf[i] ^= 0x5a;
        return range206(buf);
      }
      case 'norange':
        // Range 를 무시하고 파일 전체를 200 으로. copc.js 는 "offset 부터의 바이트"라고 믿는다.
        return send(200, read(0, size), { 'Content-Length': size });
      case 'slow':
        await new Promise((r) => setTimeout(r, 20_000));
        return range206(read(start, wanted));
      case 'flaky': {
        const key = `${start}-${end}`;
        const n = (flakyCount.get(key) ?? 0) + 1;
        flakyCount.set(key, n);
        if (n <= 2) return send(503, Buffer.from('flaky'), {});
        return range206(read(start, wanted));
      }
      case 'always500':
        return send(500, Buffer.from('boom'), {});
      case 'always403':
        return send(403, Buffer.from('nope'), {});
      default:
        res.writeHead(400).end(`unknown mode ${mode}`);
    }
  });

  await new Promise<void>((r) => server.listen(port, '127.0.0.1', r));
  const addr = server.address();
  const p = typeof addr === 'object' && addr ? addr.port : port;
  const base = `http://127.0.0.1:${p}`;
  return {
    base,
    size,
    url: (mode, scope) => `${base}/${mode}/copc${scope ? `?from=${scope.from}&to=${scope.to}` : ''}`,
    stats,
    close: () =>
      new Promise<void>((r) =>
        server.close(() => {
          closeSync(fd);
          r();
        }),
      ),
  };
}
