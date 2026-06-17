---
slug: hierarchy-subpage-paging
title: 하이어라키 서브페이지 페이징 — 깊은 옥트리를 외부 tileset으로 lazy 확장
status: active
last_verified: 2026-06-17
owner: copc-cesium
projects: [CopcCesiumLab]
---

# 하이어라키 서브페이지 페이징

> COPC의 옥트리 계층은 한 덩어리가 아니라 **페이지로 쪼개져** 있다. 루트 페이지만 읽으면 작은 데이터는 멀쩡하지만 큰 데이터는 일정 깊이에서 **조용히 잘린다**. 그래서 페이지 경계의 노드를 **외부 tileset을 가리키는 proxy 자식**으로 내보내, Cesium이 줌인할 때 그 서브페이지를 **그 순간** 불러와 깊이를 잇는다.

## 한 줄

루트 [[copc-octree-lod-streaming]] 트리에서 자식이 미로드 서브페이지를 가리키면, 점 대신 **외부 tileset(page proxy)** 한 칸을 둔다. Cesium SSE가 거기로 refine하면 [[service-worker-tile-interception]]가 그 요청을 가로채 페이지로 넘기고, 페이지는 그 서브페이지를 lazy 로드해 자식 tileset을 즉석 합성해 돌려준다. [[decode-in-worker]] 워커도 같은 서브페이지를 받아 이후 그 노드들을 디코드한다. LOD 판단은 여전히 Cesium 몫.

## 흐름 (한 눈에)

```mermaid
flowchart LR
    A["루트 tileset<br/>(루트 페이지 노드들)"]
    A -->|"미로드 서브페이지를 가리키는 노드"| PX["page-proxy 자식<br/>(외부 tileset · 점 없음)"]
    PX -->|"Cesium SSE refine → JSON 요청"| SW["SW 가로채 → 페이지"]
    SW -->|"서브페이지 lazy 로드<br/>+ 자식 tileset 합성"| SUB["서브트리 tileset<br/>(노드 점 + 자식 + 더 깊은 proxy)"]
    SUB -.->|"임의 깊이까지 재귀"| PX
```

핵심: 트리를 미리 통째로 만들지 않는다. **본 만큼만**, refine가 닿는 페이지만 그 순간 펼쳐진다.

## 왜 외부 tileset인가 (의미)

이 랩의 큰 결정은 LOD를 손코딩하지 않고 **Cesium의 SSE 순회에 위임**한 것이다(A안). 그러니 "서브페이지를 lazy하게 펼친다"도 우리 순회기가 아니라 **3D Tiles의 언어로** 표현해야 한다. 마침 3D Tiles엔 *외부 tileset* — 한 타일의 content가 또 다른 tileset을 가리키고, Cesium이 그 타일로 refine할 때만 lazy하게 불러오며, 화면오차·정밀화 기준이 경계를 넘어 자연히 이어지는 — 기능이 있다. COPC의 "미로드 서브페이지"와 "lazy 서브트리"가 1:1로 맞아떨어진다. 그래서 페이지 경계 노드마다 proxy를 한 칸 두면 **Cesium의 줌(SSE)이 곧 페이징 트리거**가 된다. 새 스트리밍 기계를 만든 게 아니라, 기존 SW 라우팅 + tileset 빌더 위에 "페이지 요청" 한 갈래만 얹었다.

대안인 *implicit tiling*은 고정 깊이 서브트리를 전제하는데, COPC 페이지 경계는 **크기 기반**이라 깊이가 들쭉날쭉하다 → 임피던스 매칭 + 가용성 비트스트림 인코더를 손코딩해야 하고, SW가 어차피 JSON을 lazy 생성하는 우리 구조에선 얻는 것 없이 복잡도만 는다. 그래서 기각.

## 조용한 갭이었다 (왜 중요)

이 결함이 무서운 건 **작은 데이터에선 안 보인다**는 점이다. 옥트리 전체가 우연히 루트 페이지 하나에 들어가는 소형 샘플은 페이징 없이도 완벽히 렌더돼서 "된다"고 착각하게 만든다. 그러나 국가 규모 대용량은 dense한 가지의 깊은 계층이 서브페이지로 분리돼 있어, 루트 페이지만 읽던 프로토타입은 줌인하면 **디테일이 그냥 끊겼다 — 에러도 없이**. 성능 이전에 **정확성** 벽이었고, 조용한 실패가 데이터 구조 수준에서 드러난 사례다. (얼마나 잘렸는지는 아래 참고의 측정값.)

## 비용·주의 (약점)

- **proxy는 한 칸 더**: 서브페이지를 소유한 노드는 부모 트리에선 점 없는 proxy로, 자기 점은 펼쳐진 외부 tileset의 루트에서 그려진다 → 점 중복은 없으나 LOD 단계가 미세하게 한 칸 늘어난다.
- **노드 누적(미해결)**: 펼친 서브페이지 노드는 세션이 사는 동안 쌓이고 축출되지 않는다(페이지·워커 양쪽). 깊은/장시간 항해 시 메모리 단조 증가 → 상한(LRU)은 측정 후 과제.
- **이중 로드**: 같은 서브페이지를 지오메트리용(페이지)·디코드용(워커)이 각각 한 번 읽는다(경량 range 읽기라 허용).
- **잘못된/만료 page 키**는 즉시 표면화(throw)하게 막아, 지연된 디코드 실패로 새지 않게 했다.

연결: [[copc-octree-lod-streaming]] · [[service-worker-tile-interception]] · [[decode-in-worker]]

## 참고 (RAW 인용)

- 설계·근거(외부 tileset vs implicit tiling 기각): ADR-003(하이어라키 서브페이지 페이징)
- 세션이 `pages`(미로드 페이지 포인터) 보관 + 서브페이지 병합: `src/copc-core.ts` (`openCopc`, `loadSubPage`)
- proxy 자식 emit + 서브트리 tileset: `src/tileset.ts` (`buildNode`/`pageProxy`/`buildSubtree`)
- 페이지 요청 온디맨드(페이지·워커 둘 다 로드): `src/copc-tileset.ts` (`buildPageTileset`, `page/{key}.json` 분기)
- 워커 서브페이지 병합: `src/decode.worker.ts` (`loadPage`)
- SW JSON 라우팅: `public/copc-sw.js` (`/__copc-real/.../page/*.json`)
- 측정(무시되던 서브페이지 규모): autzen 0 · millsite 141 · sofi 111 (`scripts/check-hierarchy.ts`); 깊이 확장 결정 검증 `scripts/check-paging.ts`
- copc.js API: `Copc.loadHierarchyPage` → `{nodes, pages}` (pages[key]=`{pageOffset,pageLength}`), 서브페이지 로드는 루트와 동일 호출
- 커밋 `cef2bd9`(Step 1 페이징) · 리뷰 fix `f8a6094`(잘못된 키 throw)
