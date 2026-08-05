import { readFileSync } from 'node:fs';
import vm from 'node:vm';

let fetchHandler: ((event: { request: Request; clientId: string; respondWith(p: Promise<Response>): void }) => void) | undefined;
let posted = 0;
let lastChannel: { port1: { onmessage?: (event: { data: unknown }) => void }; port2: object } | undefined;

class FakeMessageChannel {
  port1: { onmessage?: (event: { data: unknown }) => void } = {};
  port2 = {};
  constructor() { lastChannel = this; }
}

const fallbackClient = {
  postMessage() {
    posted++;
    lastChannel?.port1.onmessage?.({ data: { empty: true } });
  },
};

const context = {
  URL,
  Response,
  TextEncoder,
  ArrayBuffer,
  Float32Array,
  Uint8Array,
  DataView,
  Math,
  Promise,
  setTimeout,
  MessageChannel: FakeMessageChannel,
  self: {
    skipWaiting() {},
    clients: {
      claim: async () => {},
      get: async () => undefined,
      matchAll: async () => [fallbackClient],
    },
    addEventListener(type: string, handler: unknown) {
      if (type === 'fetch') fetchHandler = handler as typeof fetchHandler;
    },
  },
};

vm.runInNewContext(readFileSync(new URL('../public/copc-sw.js', import.meta.url), 'utf8'), context);
if (!fetchHandler) throw new Error('service worker fetch handler not installed');

let responsePromise: Promise<Response> | undefined;
fetchHandler({
  request: new Request('https://example.test/__copc-real/s1/0-0-0-0.pnts'),
  clientId: '',
  respondWith(p) { responsePromise = p; },
});

const response = await responsePromise!;
const pass = response.status === 503 && posted === 0;
console.log(`status=${response.status} fallbackPosts=${posted}`);
console.log(pass ? 'SW ROUTING PASS' : 'SW ROUTING FAIL');
process.exit(pass ? 0 : 1);
