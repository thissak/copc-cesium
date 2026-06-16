// 서비스워커: Cesium의 타일 content 요청(XHR)을 네트워크 계층에서 가로챈다.
//  · /__copc-real/* → 페이지로 라우팅(MessageChannel). 페이지의 copc.js가 진짜 노드를 디코드해 pnts 응답. (spike4, 본편 경로)
//  · /__copc/*      → SW가 합성 pnts 즉석 생성. (spike3, 메커니즘 증명용)

function buildSyntheticPnts(rtc, n) {
  const posBytes = n * 3 * 4;
  const rgbBytes = n * 3;
  const ftBinLen = posBytes + rgbBytes;
  const ftBin = new ArrayBuffer(ftBinLen);
  const pos = new Float32Array(ftBin, 0, n * 3);
  const col = new Uint8Array(ftBin, posBytes, rgbBytes);
  for (let i = 0; i < n; i++) {
    pos[i * 3] = ((i % 50) - 25) * 3;
    pos[i * 3 + 1] = ((Math.floor(i / 50) % 50) - 25) * 3;
    pos[i * 3 + 2] = ((i % 9) - 4) * 3;
    col[i * 3] = 255; col[i * 3 + 1] = (i * 37) % 255; col[i * 3 + 2] = (i * 91) % 255;
  }
  const ft = { POINTS_LENGTH: n, RTC_CENTER: [rtc[0], rtc[1], rtc[2]], POSITION: { byteOffset: 0 }, RGB: { byteOffset: posBytes } };
  let ftJSON = JSON.stringify(ft);
  while ((28 + ftJSON.length) % 8 !== 0) ftJSON += ' ';
  const ftJSONbytes = new TextEncoder().encode(ftJSON);
  const headerLen = 28;
  const padded = Math.ceil((headerLen + ftJSONbytes.length + ftBinLen) / 8) * 8;
  const buf = new ArrayBuffer(padded);
  const dv = new DataView(buf); const u8 = new Uint8Array(buf);
  dv.setUint8(0, 0x70); dv.setUint8(1, 0x6e); dv.setUint8(2, 0x74); dv.setUint8(3, 0x73);
  dv.setUint32(4, 1, true); dv.setUint32(8, padded, true);
  dv.setUint32(12, ftJSONbytes.length, true); dv.setUint32(16, ftBinLen, true);
  dv.setUint32(20, 0, true); dv.setUint32(24, 0, true);
  u8.set(ftJSONbytes, headerLen); u8.set(new Uint8Array(ftBin), headerLen + ftJSONbytes.length);
  return buf;
}

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);

  // 본편 경로: 페이지(copc.js)에 진짜 노드 pnts를 요청
  if (url.pathname.startsWith('/__copc-real/')) {
    e.respondWith(
      (async () => {
        let client = await self.clients.get(e.clientId);
        if (!client) {
          const all = await self.clients.matchAll({ type: 'window' });
          client = all[0];
        }
        if (!client) return new Response('no client', { status: 503 });
        const key = url.pathname.split('/').pop();
        try {
          const buf = await new Promise((resolve, reject) => {
            const ch = new MessageChannel();
            ch.port1.onmessage = (ev) =>
              ev.data && ev.data.error ? reject(new Error(ev.data.error)) : resolve(ev.data);
            client.postMessage({ type: 'copc-tile', key }, [ch.port2]);
          });
          return new Response(buf, { status: 200, headers: { 'Content-Type': 'application/octet-stream' } });
        } catch (err) {
          return new Response(String(err), { status: 500 });
        }
      })(),
    );
    return;
  }

  // 메커니즘 증명 경로: SW가 합성 pnts 생성
  if (url.pathname.startsWith('/__copc/')) {
    const cx = +url.searchParams.get('cx');
    const cy = +url.searchParams.get('cy');
    const cz = +url.searchParams.get('cz');
    e.respondWith(
      new Response(buildSyntheticPnts([cx, cy, cz], 2000), {
        status: 200,
        headers: { 'Content-Type': 'application/octet-stream' },
      }),
    );
  }
});
