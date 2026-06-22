// scripts/bench/check-profile-axes.ts — 집계·median·정규화 순수 로직 검증(네트워크 무관).
import { aggregate, selectNodes, loadNodesToDepth } from './profile-axes';
import type { NodeAxes } from './axis-measure';
import type { Hierarchy } from 'copc';

function assert(c: boolean, m: string) { if (!c) { console.log('FAIL ' + m); process.exit(1); } console.log('ok: ' + m); }

// selectNodes: depth = key 의 첫 토큰
const nodes: any = { '0-0-0-0': { pointDataLength: 10 }, '1-0-0-0': { pointDataLength: 5 }, '2-0-0-0': { pointDataLength: 0 }, '1-1-0-0': { pointDataLength: 7 } };
const sel = selectNodes(nodes, 1);
assert(JSON.stringify(sel) === JSON.stringify(['0-0-0-0', '1-0-0-0', '1-1-0-0']), 'depth≤1·점>0 만, depth 오름차순');

// aggregate: 2 run × 2 노드. run 합 = 노드 합. median(2개)=상위값(Math.floor(0.5*2)=1 → 정렬 2번째)
const r1: NodeAxes[] = [
  { points: 1_000_000, ioMs: 1, decodeMs: 10, reprojectMs: 2, buildMs: 1 },
  { points: 1_000_000, ioMs: 1, decodeMs: 10, reprojectMs: 2, buildMs: 1 },
];
const r2: NodeAxes[] = [
  { points: 1_000_000, ioMs: 1, decodeMs: 20, reprojectMs: 4, buildMs: 2 },
  { points: 1_000_000, ioMs: 1, decodeMs: 20, reprojectMs: 4, buildMs: 2 },
];
const agg = aggregate([r1, r2]);
assert(agg.points === 2_000_000, 'points 합 = 2M (run 무관 동일)');
// run 합: run1 decode=20, run2 decode=40 → median(2개)=40
assert(agg.decode.ms === 40, `decode median run-sum = 40 (got ${agg.decode.ms})`);
assert(Math.abs(agg.decode.msPerM - 40 / 2) < 1e-6, 'decode ms/1M점 = 20');
const pctSum = agg.io.pct + agg.decode.pct + agg.reproject.pct + agg.build.pct;
assert(Math.abs(pctSum - 100) < 0.5, '축 % 합 ≈ 100');

// aggregate([]): 빈 runs → throw (NaN 직렬화 방어)
{
  let threw = false;
  try { aggregate([]); } catch (e) { threw = true; }
  assert(threw, 'aggregate([]) throws on empty runs');
}

// loadNodesToDepth: mock loadPage로 BFS depth 필터·visited dedup 검증
{
  // 페이지 레이아웃:
  //   root  (offset=0, length=1): 노드 0-0-0-0(depth 0), 1-0-0-0(depth 1), 2-0-0-0(depth 2)
  //                               + 서브페이지 refs: subA(depth=3 marker), subB(depth=7 marker)
  //                               + dupRef(=root 동일 offset/length — visited dedup 테스트)
  //   subA  (offset=10, length=1): 노드 3-0-0-0(depth 3)
  //   subB  (offset=20, length=1): 노드 7-0-0-0(depth 7) — maxDepth=3 이면 로드 안 함
  const pageRoot: Hierarchy.Page = { pageOffset: 0, pageLength: 1 };
  const pageSubA: Hierarchy.Page = { pageOffset: 10, pageLength: 1 };
  const pageSubB: Hierarchy.Page = { pageOffset: 20, pageLength: 1 };

  const makeNode = (offset: number) => ({ pointDataOffset: offset, pointDataLength: 1 });

  let loadCallCount = 0;
  const mockLoadPage = async (
    _g: (b: number, e: number) => Promise<Uint8Array>,
    page: Hierarchy.Page,
  ): Promise<{ nodes: Hierarchy.Node.Map; pages: Record<string, Hierarchy.Page | undefined> }> => {
    loadCallCount++;
    if (page.pageOffset === 0) {
      return {
        nodes: {
          '0-0-0-0': makeNode(0) as any,
          '1-0-0-0': makeNode(1) as any,
          '2-0-0-0': makeNode(2) as any,
        },
        pages: {
          '3-0-0-0': pageSubA,   // depth=3 마커 — maxDepth=3 이면 로드 필요
          '7-0-0-0': pageSubB,   // depth=7 마커 — maxDepth=3 이면 스킵
          'dup': pageRoot,        // 동일 offset/length — visited dedup 테스트
        },
      };
    }
    if (page.pageOffset === 10) {
      return {
        nodes: { '3-0-0-0': makeNode(3) as any },
        pages: {},
      };
    }
    if (page.pageOffset === 20) {
      return {
        nodes: { '7-0-0-0': makeNode(7) as any },
        pages: {},
      };
    }
    throw new Error(`unexpected page offset ${page.pageOffset}`);
  };

  const fakeGetter = async (_b: number, _e: number): Promise<Uint8Array> => new Uint8Array(0);
  const fakeCopc = { info: { rootHierarchyPage: pageRoot } } as any;

  const result = await loadNodesToDepth(fakeGetter, fakeCopc, 3, mockLoadPage);

  // depth≤3 노드 전부 포함
  assert('0-0-0-0' in result, 'loadNodesToDepth: depth-0 노드 포함');
  assert('1-0-0-0' in result, 'loadNodesToDepth: depth-1 노드 포함');
  assert('2-0-0-0' in result, 'loadNodesToDepth: depth-2 노드 포함');
  assert('3-0-0-0' in result, 'loadNodesToDepth: depth-3 노드 포함 (subA 로드됨)');

  // depth-7 서브페이지는 로드 안 함 (depth>maxDepth 스킵)
  assert(!('7-0-0-0' in result), 'loadNodesToDepth: depth-7 노드 미포함 (subB 스킵됨)');

  // visited dedup — root(offset=0,length=1)는 dupRef로 재참조돼도 1회만 로드
  // 총 호출: root(1) + subA(1) = 2. subB는 스킵, dup는 visited 차단 → 2회
  assert(loadCallCount === 2, `loadNodesToDepth: loadPage 호출 2회 (중복·depth초과 스킵) — got ${loadCallCount}`);
}

console.log('ALL PASS ✅');
