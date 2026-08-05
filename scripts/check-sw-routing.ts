import { readFileSync } from 'node:fs';
import vm from 'node:vm';

let fetchHandler: ((event: { request: Request; clientId: string; respondWith(p: Promise<Response>): void }) => void) | undefined;
let posted = 0;
let resolvedClient: typeof realClient | undefined;
let lastChannel: { port1: { onmessage?: (event: { data: unknown }) => void }; port2: object } | undefined;

class FakeMessageChannel {
  port1: { onmessage?: (event: { data: unknown }) => void } = {};
  port2 = {};
  constructor() { lastChannel = this; }
}

const realClient = {
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
      get: async (id: string) => id === 'c1' ? resolvedClient : undefined,
      matchAll: async () => [realClient],
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
const missingPass = response.status === 503 && posted === 0;

responsePromise = undefined;
fetchHandler({
  request: new Request('https://example.test/__copc-real/s1/0-0-0-0.pnts'),
  clientId: 'c-gone',
  respondWith(p) { responsePromise = p; },
});
const expiredResponse = await responsePromise!;
const expiredPass = expiredResponse.status === 503 && posted === 0;

resolvedClient = realClient;
responsePromise = undefined;
fetchHandler({
  request: new Request('https://example.test/__copc-real/s1/0-0-0-0.pnts'),
  clientId: 'c1',
  respondWith(p) { responsePromise = p; },
});
const routedResponse = await responsePromise!;
const pass = missingPass && expiredPass && routedResponse.status === 404 && posted === 1;
console.log(`missingStatus=${response.status} expiredStatus=${expiredResponse.status} routedStatus=${routedResponse.status} posts=${posted}`);
console.log(pass ? 'SW ROUTING PASS' : 'SW ROUTING FAIL');
process.exit(pass ? 0 : 1);
