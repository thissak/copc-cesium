// 하이어라키 페이징 갭 측정: 루트 페이지에 서브페이지 포인터(pages)가 있는데 우리가 버리는가?
// openCopc 는 loadHierarchyPage 의 {nodes} 만 쓰고 {pages} 를 무시한다 → 깊은 노드 미스트리밍.
// 실행: npx tsx scripts/check-hierarchy.ts [url]
import { Copc, Getter } from 'copc';

const url = process.argv[2] ?? 'https://s3.amazonaws.com/hobu-lidar/autzen-classified.copc.laz';
const getter = Getter.http(url);
const copc = await Copc.create(getter);
const root = await Copc.loadHierarchyPage(getter, copc.info.rootHierarchyPage);

const nodeKeys = Object.keys(root.nodes).filter((k) => root.nodes[k]);
const pageKeys = Object.keys(root.pages).filter((k) => root.pages[k]);
const depths = nodeKeys.map((k) => Number(k.split('-')[0]));

console.log(
  JSON.stringify(
    {
      url,
      rootPageNodes: nodeKeys.length,
      subPages_IGNORED: pageKeys.length, // >0 이면 갭 실재 — 이 sub-page 들의 노드가 안 보인다
      subPageKeys: pageKeys,
      maxDepthReachable: depths.length ? Math.max(...depths) : -1,
      totalPointsInRootPage: nodeKeys.reduce((s, k) => s + (root.nodes[k]?.pointCount ?? 0), 0),
    },
    null,
    2,
  ),
);
