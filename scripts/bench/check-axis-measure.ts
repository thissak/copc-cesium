// scripts/bench/check-axis-measure.ts — autzen(실 S3)로 축 분리·IO 독립성 검증.
import { Copc } from 'copc';
import { resolveCrs, makeGridReprojector } from '../../src/copc-core';
import { makeTimedGetter } from './axis-getter';
import { measureNode } from './axis-measure';

function assert(c: boolean, m: string) { if (!c) { console.log('FAIL ' + m); process.exit(1); } console.log('ok: ' + m); }
const URL = 'https://s3.amazonaws.com/hobu-lidar/autzen-classified.copc.laz';

async function firstNode(fetchImpl?: typeof fetch) {
  const { getter, io } = makeTimedGetter(URL, fetchImpl);
  const copc = await Copc.create(getter);
  const { nodes } = await Copc.loadHierarchyPage(getter, copc.info.rootHierarchyPage);
  const { toWgs, zUnit } = resolveCrs(copc.wkt);
  const reproj = makeGridReprojector(toWgs, copc.header.min, copc.header.max);
  const zRange: [number, number] = [copc.header.min[2] * zUnit, copc.header.max[2] * zUnit];
  const key = Object.keys(nodes).filter((k) => nodes[k] && nodes[k]!.pointDataLength)[0];
  io.length = 0; // 노드 측정 직전 IO 버퍼 초기화
  const ax = await measureNode(getter, io, copc, nodes[key]!, reproj, zUnit, zRange);
  return ax!;
}

// (a) 정상: 모든 축 > 0, points > 0
const base = await firstNode();
assert(base.points > 0, 'points > 0');
assert(base.decodeMs > 0 && base.reprojectMs > 0 && base.buildMs > 0, '세 내부축 모두 > 0');

// (b) IO 분리 정확성: 200ms 지연 getter → ioMs 만 +지연, decode/reproject/build 불변(±40%)
// ioMs>=200 은 주입 sanity(지연이 IO 축에 먹었다), decode 불변이 분리 증명(IO 가 decode 로 안 샘 = AC#4).
const delayed = await firstNode((async (u: string, o: { headers?: Record<string,string> }) => {
  await new Promise((r) => setTimeout(r, 200));
  return fetch(u, o as RequestInit);
}) as unknown as typeof fetch);
assert(delayed.ioMs >= 200, `주입한 200ms 지연이 ioMs 에 반영(절대 하한, got ${delayed.ioMs.toFixed(0)})`);
// within(measured, reference): reference(base) 값 기준 ±40% (비대칭 — 인수 순서 주의)
const within = (a: number, b: number) => Math.abs(a - b) <= b * 0.4 + 2;
assert(within(delayed.decodeMs, base.decodeMs), `decode 는 IO 지연에 불변(${base.decodeMs.toFixed(1)} vs ${delayed.decodeMs.toFixed(1)})`);
console.log('MEASURE PASS ✅  축 분리·IO 독립 확인');
