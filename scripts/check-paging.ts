// 페이징 데이터경로 결정적 검증: 서브페이지 노드가 로드 전엔 미스, loadSubPage 후 디코드되는가.
// 실행: npx tsx scripts/check-paging.ts [url]   (기본 millsite — 서브페이지 141개)
import { openCopc, loadSubPage, decodeNode } from '../src/copc-core';

const url = process.argv[2] ?? 'https://s3.amazonaws.com/hobu-lidar/millsite.copc.laz';
const s = await openCopc(url);
const rootNodes = Object.keys(s.nodes).length;
const pageKeys = Object.keys(s.pages);

if (pageKeys.length === 0) {
  console.log(JSON.stringify({ url, subPages: 0, note: '서브페이지 없음(단일 페이지)' }, null, 2));
  process.exit(0);
}

const sampleKey = pageKeys[0];
const samplePage = s.pages[sampleKey];
const baseGetter = s.getter;
let samplePageReads = 0;
s.getter = async (begin, end) => {
  if (begin === samplePage.pageOffset && end === samplePage.pageOffset + samplePage.pageLength)
    samplePageReads++;
  return baseGetter(begin, end);
};
// 페이징 전: 서브페이지 노드는 nodes 에 없어 디코드 불가
const beforeInNodes = !!s.nodes[sampleKey];
const beforeDecode = await decodeNode(s, sampleKey); // null 기대

// 서브페이지 로드 → 병합
const [loaded, concurrentlyLoaded] = await Promise.all([
  loadSubPage(s, sampleKey),
  loadSubPage(s, sampleKey),
]);
const afterInNodes = !!s.nodes[sampleKey];
const dec = await decodeNode(s, sampleKey); // 점 디코드 기대

const pass =
  !beforeInNodes && beforeDecode === null && loaded && concurrentlyLoaded && samplePageReads === 1 &&
  afterInNodes && (dec?.count ?? 0) > 0;
console.log(
  JSON.stringify(
    {
      url,
      rootNodes,
      subPagesInRoot: pageKeys.length,
      sampleKey,
      before: { inNodes: beforeInNodes, decode: beforeDecode === null ? 'null(미스)' : '!!' },
      loaded,
      concurrentlyLoaded,
      samplePageReads,
      after: {
        inNodes: afterInNodes,
        nodesAdded: Object.keys(s.nodes).length - rootNodes,
        decodedPoints: dec?.count ?? 0,
        deeperPagePtrs: Object.keys(s.pages).length,
      },
    },
    null,
    2,
  ),
);
console.log(pass ? '\nPAGING PASS ✅  서브페이지 노드가 로드 후 디코드됨' : '\nPAGING FAIL ❌');
process.exit(pass ? 0 : 1);
