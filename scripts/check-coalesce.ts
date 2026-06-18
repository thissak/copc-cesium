import { groupRuns, createRegionCache, createCoalescingGetter, rangeTimeoutMs, openCopc, decodeNode, loadSubPage, type ByteRange, type RangeGetter } from '../src/copc-core';

function assert(cond: boolean, msg: string) {
  if (!cond) {
    console.error('FAIL: ' + msg);
    process.exit(1);
  }
  console.log('ok: ' + msg);
}

// --- Task 1: groupRuns ---
const KB = 1024;
const MB = 1024 * 1024;

// 완전 인접 → 1 run
assert(
  JSON.stringify(groupRuns([{ off: 0, len: 100 }, { off: 100, len: 100 }], 256 * KB, 8 * MB)) ===
    JSON.stringify([{ start: 0, end: 200 }]),
  'groupRuns: 인접 2노드 → 1 run',
);
// gap > maxGap → 분리
assert(
  groupRuns([{ off: 0, len: 100 }, { off: 100 + 300 * KB, len: 100 }], 256 * KB, 8 * MB).length === 2,
  'groupRuns: gap > maxGap → 2 run',
);
// span > maxBytes → 분리
assert(
  groupRuns([{ off: 0, len: 5 * MB }, { off: 5 * MB, len: 5 * MB }], 256 * KB, 8 * MB).length === 2,
  'groupRuns: span > maxBytes → 2 run',
);
// 정렬되지 않은 입력 → off 정렬 후 그룹핑 (octree 순 가정 금지)
assert(
  JSON.stringify(groupRuns([{ off: 100, len: 100 }, { off: 0, len: 100 }], 256 * KB, 8 * MB)) ===
    JSON.stringify([{ start: 0, end: 200 }]),
  'groupRuns: 역순 입력도 off 정렬 후 1 run',
);
// 빈 배열
assert(groupRuns([], 256 * KB, 8 * MB).length === 0, 'groupRuns: 빈 입력 → []');
// gap 정확히 = maxGap → 병합(경계 포함)
assert(
  groupRuns([{ off: 0, len: 100 }, { off: 100 + 256 * KB, len: 100 }], 256 * KB, 8 * MB).length === 1,
  'groupRuns: gap == maxGap → 병합',
);
console.log('Task 1 passed');

// --- Task 2: createRegionCache ---
{
  const c = createRegionCache(1000);
  const region = new Uint8Array([10, 11, 12, 13, 14]); // [start=100, end=105)
  c.insert(100, 105, region);
  const hit = c.lookup(101, 104);
  assert(!!hit && hit.length === 3 && hit[0] === 11 && hit[2] === 13, 'regionCache: 덮는 lookup → 슬라이스');
  assert(c.lookup(200, 210) === undefined, 'regionCache: 미덮음 → undefined');
  // 슬라이스는 복사본 — 원본 변형 무영향
  region[1] = 99;
  assert(c.lookup(101, 104)![0] === 11, 'regionCache: 슬라이스는 복사본(원본 변형 무영향)');
  // 부분 덮음(걸침) → undefined
  assert(c.lookup(104, 110) === undefined, 'regionCache: 부분 덮음 → undefined');
}
{
  // LRU 축출: maxBytes 작게 → 오래된 region 축출
  const c = createRegionCache(10);
  c.insert(0, 6, new Uint8Array(6)); // 6B
  c.insert(10, 16, new Uint8Array(6)); // +6=12 > 10 → 첫 region 축출
  assert(c.lookup(0, 6) === undefined, 'regionCache: 총바이트 초과 → LRU 축출(오래된 것)');
  assert(!!c.lookup(10, 16), 'regionCache: 최신 region 유지');
}
{
  // lookup 으로 MRU 갱신 → 다음 축출 대상이 바뀜
  const c = createRegionCache(12);
  c.insert(0, 6, new Uint8Array(6));
  c.insert(10, 16, new Uint8Array(6)); // 12, 딱 맞음(축출 없음)
  c.lookup(0, 6); // region0 을 MRU 로
  c.insert(20, 26, new Uint8Array(6)); // 18 > 12 → LRU(region1=10-16) 축출
  assert(!!c.lookup(0, 6), 'regionCache: MRU 갱신된 region0 유지');
  assert(c.lookup(10, 16) === undefined, 'regionCache: LRU(region1) 축출');
}
{
  // Codex: 캐시 전체보다 큰 region 은 보관 안 함(cap 엄수)
  const c = createRegionCache(10);
  c.insert(0, 50, new Uint8Array(50)); // 50 > 10 → skip
  assert(c.lookup(0, 50) === undefined, 'regionCache: maxBytes 초과 단일 region → 미보관(cap 엄수)');
}
console.log('Task 2 passed');

// --- Task 3: createCoalescingGetter ---
{
  // 합성 "파일" 10MB, base getter 가 슬라이스 반환 + 호출 카운트
  const file = new Uint8Array(10 * MB);
  for (let i = 0; i < file.length; i++) file[i] = i & 0xff;
  let baseCalls = 0;
  const base: RangeGetter = async (begin, end) => {
    baseCalls++;
    return file.slice(begin, end);
  };
  // 노드 3개: 인접(같은 run)
  const nodes: ByteRange[] = [
    { off: 0, len: 1000 },
    { off: 1000, len: 1000 },
    { off: 2000, len: 1000 },
  ];
  const g = createCoalescingGetter(base, () => nodes, { maxGap: 256 * KB, maxBytes: 8 * MB, cacheBytes: 64 * MB });

  // 노드 읽기 → base 슬라이스와 byte-identical
  const a = await g(0, 1000);
  const expectA = file.slice(0, 1000);
  assert(a.length === 1000 && a.every((v, i) => v === expectA[i]), 'coalescing: 노드 읽기 byte-identical');

  // 같은 run 의 다른 노드 → 캐시 히트(base 추가 호출 0)
  const before = baseCalls;
  const b = await g(1000, 2000);
  const expectB = file.slice(1000, 2000);
  assert(b.every((v, i) => v === expectB[i]) && baseCalls === before, 'coalescing: 같은 run 형제 → 캐시 히트(base 0)');

  // base 는 run 전체를 1번만 fetch (3노드 인접 → 1 run → 1 호출)
  assert(baseCalls === 1, 'coalescing: 3 인접노드 = 1 base 호출(=1 GET)');

  // 비-노드 읽기(헤더 등, 정확일치 아님) → passthrough(base 호출)
  const headerBefore = baseCalls;
  await g(5 * MB, 5 * MB + 100); // 노드 off/len 과 불일치
  assert(baseCalls === headerBefore + 1, 'coalescing: 비-노드 읽기 → passthrough');
}
{
  // in-flight dedup: 같은 run 의 2 노드 동시 요청 → base 1번
  const file = new Uint8Array(1 * MB);
  let baseCalls = 0;
  const base: RangeGetter = async (begin, end) => {
    baseCalls++;
    await new Promise((r) => setTimeout(r, 20));
    return file.slice(begin, end);
  };
  const nodes: ByteRange[] = [{ off: 0, len: 1000 }, { off: 1000, len: 1000 }];
  const g = createCoalescingGetter(base, () => nodes, { maxGap: 256 * KB, maxBytes: 8 * MB, cacheBytes: 64 * MB });
  await Promise.all([g(0, 1000), g(1000, 2000)]); // 동시
  assert(baseCalls === 1, 'coalescing: 동시 같은-run 요청 → in-flight 공유(base 1)');
}
{
  // off=0 폴백 동작은 wiring(Task 5)에서. 여기선 maxGap 작아 분리되는지
  const file = new Uint8Array(1 * MB);
  let baseCalls = 0;
  const base: RangeGetter = async (begin, end) => {
    baseCalls++;
    return file.slice(begin, end);
  };
  const nodes: ByteRange[] = [{ off: 0, len: 100 }, { off: 100 + 300 * KB, len: 100 }];
  const g = createCoalescingGetter(base, () => nodes, { maxGap: 256 * KB, maxBytes: 8 * MB, cacheBytes: 64 * MB });
  await g(0, 100);
  await g(100 + 300 * KB, 100 + 300 * KB + 100);
  assert(baseCalls === 2, 'coalescing: gap>maxGap 인 두 노드 → 2 base 호출(병합 안 함)');
}
console.log('Task 3 passed');

// --- Task 4: 크기비례 타임아웃 ---
assert(rangeTimeoutMs(0, 100 * KB, 8000) === 8000, 'timeout: 작은 range → base 8s');
assert(rangeTimeoutMs(0, 8 * MB, 8000) === 16000, 'timeout: 8MB → 16s');
assert(rangeTimeoutMs(0, 1 * MB, 8000) === 8000, 'timeout: 1MB → max(8000, 2000)=8s');
assert(rangeTimeoutMs(0, 5 * MB, 8000) === 10000, 'timeout: 5MB → 10s');
console.log('Task 4 passed');

// --- Task 7 (#04): rebuild-중-inflight 레이스 — run 이 커져도 잘린/빈 바이트 안 줌 ---
// 버그: inflight 가 run.start 로만 dedup → 서브페이지 로드로 run.end 가 커지면(같은 start) 옛(작은)
// region 을 새 run offset 으로 슬라이스 → 범위초과 → 빈 바이트 → laz-perf garbage 디코드(WASM 폭증).
// 수정(C+B): region 을 fetch 정체성([start,end])으로 슬라이스 + 커버리지 미달 시 base 직접 폴백.
{
  const file = new Uint8Array(1 * MB);
  for (let i = 0; i < file.length; i++) file[i] = i & 0xff;
  let baseCalls = 0;
  let releaseFirst!: () => void;
  const firstGate = new Promise<void>((r) => { releaseFirst = r; });
  const base: RangeGetter = async (begin, end) => {
    const callNo = ++baseCalls;
    if (callNo === 1) await firstGate; // 첫 fetch 를 hang → rebuild 레이스 창 확보
    return file.slice(begin, end);
  };
  // 처음 노드 1개 → run [0,1000). 이후 인접 노드 추가 → rebuild 시 run 이 [0,2000) 으로 확장(같은 start=0).
  let nodes: ByteRange[] = [{ off: 0, len: 1000 }];
  const g = createCoalescingGetter(base, () => nodes, { maxGap: 256 * KB, maxBytes: 8 * MB, cacheBytes: 64 * MB });

  const pA = g(0, 1000); // 노드 A → run [0,1000) fetch 시작(첫 호출, hang). await p 에서 suspend.
  nodes = [{ off: 0, len: 1000 }, { off: 1000, len: 1000 }]; // "rebuild" 유발(노드 수 변함)
  const pB = g(1000, 2000); // 노드 B → rebuild → run [0,2000). inflight.get(0)=pA([0,1000)). 버그면 빈 슬라이스.
  releaseFirst(); // 첫 fetch 해제 → 둘 다 resolve

  const a = await pA;
  const b = await pB;
  const expectA = file.slice(0, 1000);
  const expectB = file.slice(1000, 2000);
  assert(a.length === 1000 && a.every((v, i) => v === expectA[i]), '#04: 레이스 — 노드 A byte-identical');
  assert(
    b.length === 1000 && b.every((v, i) => v === expectB[i]),
    '#04: 레이스 — run 확장돼도 노드 B 빈/잘린 바이트 0(byte-identical)',
  );
}
console.log('Task 7 passed');

// --- Task 6: 골든파일(실 S3, COALESCE_NET=1 일 때만) ---
if (process.env.COALESCE_NET === '1') {
  const NET_URL = 'https://s3.amazonaws.com/hobu-lidar/millsite.copc.laz';
  const plain = await openCopc(NET_URL); // coalesce off
  const coal = await openCopc(NET_URL, { coalesce: { maxGap: 256 * KB, maxBytes: 8 * MB, cacheBytes: 64 * MB } });
  // 루트+서브페이지 일부 로드해 깊은 노드 확보
  for (const k of Object.keys(plain.pages)) {
    if (Number(k.split('-')[0]) <= 2) {
      await loadSubPage(plain, k);
      await loadSubPage(coal, k);
    }
  }
  const keys = Object.keys(plain.nodes).filter((k) => Number(k.split('-')[0]) <= 3).slice(0, 5);
  for (const key of keys) {
    const a = await decodeNode(plain, key, undefined, 'rgb'); // Node: lazPerf 생략(copc node 빌드)
    const b = await decodeNode(coal, key, undefined, 'rgb');
    const same =
      !!a && !!b && a.count === b.count && a.lonLatH.length === b.lonLatH.length &&
      a.lonLatH.every((v, i) => v === b.lonLatH[i]);
    assert(same, `골든파일: 노드 ${key} per-node vs coalesced 동일(count=${a?.count})`);
  }
  console.log('Task 6 골든파일 passed');
} else {
  console.log('Task 6 골든파일 skip (COALESCE_NET=1 로 실행)');
}
console.log('check-coalesce 전체 passed');
