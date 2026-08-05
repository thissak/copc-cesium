# ADR-003: 하이어라키 서브페이지 페이징 = 외부 tileset proxy (lazy 서브트리)

- **상태**: Accepted (2026-06-17)
- **근거 문서**: [ADR-001](001-provider-plugin-architecture-A.md)(A안·LOD Cesium 위임) · [ADR-002](002-service-worker-tile-interception.md)(SW 라우터) · 측정(`scripts/check-hierarchy.ts`·`check-paging.ts`) · BP 조사(copc.js·Potree·Giro3D·3D Tiles)

## 맥락

- COPC 하이어라키는 **페이징**된다: `Copc.loadHierarchyPage` 가 `{nodes, pages}` 를 주고, `pages[key]`(= `pointCount === -1` 항목)는 미로드 자식 페이지 포인터(`{pageOffset,pageLength}`).
- 기존 `openCopc` 는 루트 페이지의 `{nodes}` 만 쓰고 `{pages}` 를 버려, **깊은/대용량 옥트리가 일정 깊이에서 미스트리밍**됐다. 측정: Autzen 서브페이지 0(전부 렌더돼 "됐던" 것), **millsite 141 · sofi 111** 서브페이지가 통째로 안 보임. 성능 이전에 **정확성 갭**.
- 제약(ADR-001/002): LOD 는 Cesium SSE 에 위임, SW 는 라우터(copc.js 미번들). 새 스트리밍 traversal 을 손코딩하지 않는다.

## 결정

- 옥트리를 **외부 tileset**으로 lazy 확장한다. 루트 tileset 에서 `pages[key]` 노드는 point content 대신 **외부 tileset 을 가리키는 proxy 자식 타일** 1개로 표현(`content.uri = …/{sid}/page/{key}.json`).
- Cesium 이 SSE refine 로 proxy 에 닿으면 그 JSON 을 요청 → SW 가 가로채 페이지로 라우팅 → 페이지가 `loadSubPage(getter, pages[key])` 로 서브페이지를 로드하고 `buildSubtree` 로 child tileset JSON 을 즉석 생성·응답. 워커도 `loadPage` 로 동일 서브페이지를 병합(후속 `.pnts` 디코드 가능).
- geometricError/region 은 경계에서 자동 연속(Cesium "merged-parent" 규칙) — proxy 와 외부 root 의 GE = 해당 노드 GE.

## 기각: 3D Tiles 1.1 implicit tiling

- octree availability 비트스트림(Morton)·고정 `subtreeLevels` 필요. COPC 페이지 경계는 크기 기반이라 고정 깊이와 불일치 → 임피던스 매칭 레이어 + 비트스트림 인코더 손코딩. SW 가 JSON 을 lazy 생성하는 우리 구조에선 **얻는 것(수백만 타일 압축 열거) 없이 복잡도만↑**. 외부 tileset 은 3D Tiles 1.0 기본·Cesium 1.142 완전 지원으로 최소 변경.

## 결과 (Consequences)

- **(+)** GB 국가규모 옥트리를 임의 깊이까지 lazy 스트리밍. ADR-001/002 불변(LOD 위임·SW 라우터). 새 스트리밍 primitive 없음. `buildTileset`/`buildNode` 재사용.
- **(−/주의)** page-pointer 노드 K 는 부모 페이지엔 `-1` 포인터, 자기 서브페이지엔 실노드로 존재 → **K 점 중복 방지**: proxy 는 content=json(점 없음), K 점은 외부 root 에서만 1회. proxy→외부 root 로 한 단계 늘어 LOD 타이밍 미세 차이(검증됨, 필요시 GE 튜닝).
- **(−)** 페이지당 fetch 는 페이지·워커 2회(현 dual-openCopc 와 동일 패턴, 경량·세션 캐시).
- 검증: Node `check-paging`(서브페이지 88노드·23,359점 디코드) + 브라우저 millsite(서브페이지 노드 `.pnts` 500→200, `page/K.json` 200·유효 child tileset).

### 보강 (2026-08-06): 세션 내 동시 로드 single-flight

페이지 측 세션이나 워커 세션 각각에서 같은 key를 동시에 요청하면 진행 중 Promise를 공유한다.
완료 결과를 영구 캐시하지 않고 in-flight 동안만 공유하며, 성공 시에만 page pointer를 지운다.
실패한 Promise는 즉시 registry에서 제거하므로 다음 호출이 원래 pointer로 재시도할 수 있다.
페이지와 워커가 각자 한 번 읽는 dual-session 구조는 그대로이며 세션 내부 중복만 제거한다.
`check:paging`은 동일 key 동시 호출의 hierarchy range read가 2회에서 1회로 감소함을 고정한다.

## 다음

워커풀·LRU(측정 후), 속성 견고성(intensity/classification), 복원력. 페이징 시각·성능은 실 GPU 대용량(millsite/sofi)에서 측정.
