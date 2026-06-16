// 스파이크 ③ 서비스워커: Cesium의 타일 content 요청(XHR)을 네트워크 계층에서 가로채
// 요청 시점에 pnts 를 생성해 응답한다. (fetch/XHR 무관하게 SW의 fetch 이벤트가 잡음)
// 여기선 합성 점군으로 "가로채기+온디맨드 생성"만 증명. 실제 COPC 디코드는 후속.

function buildPnts(rtc, n) {
  const posBytes = n * 3 * 4;
  const rgbBytes = n * 3;
  const ftBinLen = posBytes + rgbBytes;
  const ftBin = new ArrayBuffer(ftBinLen);
  const pos = new Float32Array(ftBin, 0, n * 3);
  const col = new Uint8Array(ftBin, posBytes, rgbBytes);
  for (let i = 0; i < n; i++) {
    // RTC 상대 오프셋(미터): 작은 격자
    pos[i * 3] = ((i % 50) - 25) * 3;
    pos[i * 3 + 1] = ((Math.floor(i / 50) % 50) - 25) * 3;
    pos[i * 3 + 2] = ((i % 9) - 4) * 3;
    col[i * 3] = 255;
    col[i * 3 + 1] = (i * 37) % 255;
    col[i * 3 + 2] = (i * 91) % 255;
  }
  const ft = { POINTS_LENGTH: n, RTC_CENTER: [rtc[0], rtc[1], rtc[2]], POSITION: { byteOffset: 0 }, RGB: { byteOffset: posBytes } };
  let ftJSON = JSON.stringify(ft);
  while ((28 + ftJSON.length) % 8 !== 0) ftJSON += ' ';
  const ftJSONbytes = new TextEncoder().encode(ftJSON);
  const headerLen = 28;
  const total = headerLen + ftJSONbytes.length + ftBinLen;
  const padded = Math.ceil(total / 8) * 8;
  const buf = new ArrayBuffer(padded);
  const dv = new DataView(buf);
  const u8 = new Uint8Array(buf);
  dv.setUint8(0, 0x70); dv.setUint8(1, 0x6e); dv.setUint8(2, 0x74); dv.setUint8(3, 0x73);
  dv.setUint32(4, 1, true); dv.setUint32(8, padded, true);
  dv.setUint32(12, ftJSONbytes.length, true); dv.setUint32(16, ftBinLen, true);
  dv.setUint32(20, 0, true); dv.setUint32(24, 0, true);
  u8.set(ftJSONbytes, headerLen);
  u8.set(new Uint8Array(ftBin), headerLen + ftJSONbytes.length);
  return buf;
}

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (url.pathname.startsWith('/__copc/')) {
    const cx = +url.searchParams.get('cx');
    const cy = +url.searchParams.get('cy');
    const cz = +url.searchParams.get('cz');
    const buf = buildPnts([cx, cy, cz], 2000); // ← 요청 시점에 생성
    e.respondWith(new Response(buf, { status: 200, headers: { 'Content-Type': 'application/octet-stream' } }));
  }
});
