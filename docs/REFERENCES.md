# Prior Art / 레퍼런스 정독 (2026-06-16)

> "바퀴 재발명 금지" — COPC를 웹/Cesium에 띄우는 기존 구현 지도. 무엇이 열려 있고(읽기 가능) 무엇이 닫혀 있나.

## 결론 한 줄

오픈소스 **빌딩블록**(copc.js·laz-perf·Cesium)과 오픈소스 **포인트클라우드 스트리머**(Giro3D·iTowns·Potree)는 있다.
그러나 **Cesium 전용 오픈소스 COPC 통합은 부재** — 완성품(Eptium / viewer.copc.io)은 전부 같은 제작자(Connor Manning/Hobu)의 **상용**이다. → 과제의 갭이 실재.

→ 이 갭을 *어떤 성능 목표로* 채울지(Eptium은 잣대 아님, 오픈 동료가 비교선)는 [STRATEGY.md](STRATEGY.md) 참조.

## 닫힌 레퍼런스 (읽을 수 없음)

| 이름 | 정체 | 비고 |
|------|------|------|
| **Eptium** (eptium.com) | Hobu 상용 제품. COPC→브라우저 on-the-fly 3D Tiles→Cesium, 국가 규모 | "Is Eptium open source? Nope." 라이선스 판매 |
| **viewer.copc.io** | 공식 COPC 뷰어, Cesium 기반 | Connor Manning 제작 = 사실상 Eptium 기술. repo 없음 |
| hobu.co/copc-viewer.html, moon.html | 전부 Eptium 마케팅/리다이렉트 | 소스 아님 |

## 열린 레퍼런스 (읽고 크립 가능) ★

| 이름 | 렌더러 | 무엇을 배우나 | 위치 |
|------|--------|--------------|------|
| **Giro3D `COPCSource`** ★ | Three.js | COPC fetch+decode+octree LOD의 **읽을 수 있는 최선 구현**. copc.js 사용, **LAZ 디코드를 Web Worker**에서. 소스(fetch→pivot) / 엔티티(consume→display) **분리 설계** | gitlab.com/giro3d/giro3d (MR !750) |
| **Potree `copc.html`** | 자체 WebGL | 성숙한 COPC 옥트리 스트리밍·LOD·EDL | github.com/potree/potree (develop/examples/copc.html) |
| **Potree `cesium_retz.html`** ★ | Potree+**Cesium** | **Potree 점 렌더러를 Cesium 씬에 오버레이 + 카메라 동기화** 패턴 | potree/potree.github.io |
| **copc.js** | (없음) | 파싱·`Getter.http` range·laz-perf 디코드·옥트리 (설치됨) | connormanning/copc |

공통: iTowns·Giro3D·Potree·loaders.gl 전부 **copc.js + laz-perf** 기반. 즉 데이터 레이어는 사실상 표준화됨.

## Cesium 통합 — 3가지 아키텍처 옵션

| 옵션 | 방식 | 장점 | 단점 | 열린 레퍼런스 |
|------|------|------|------|--------------|
| **A. on-the-fly 3D Tiles** | COPC 옥트리→메모리 가짜 tileset+pnts→Cesium 네이티브 렌더 | Cesium SSE/컬링/LOD 공짜. 가장 "Cesium 라이브러리"다움(과제 적합) | 변환 글루 직접. 레퍼런스가 전부 닫힘 | 없음(Eptium만, 닫힘) |
| **B. custom WebGL primitive** | Cesium Primitive로 점 직접 렌더 + LOD 손코딩 | 완전 제어 | LOD/컬링 재발명 — 최다 작업 | (Giro3D 로직 참고) |
| **C. Potree-in-Cesium 하이브리드** | Potree가 점 렌더, Cesium은 지구본, 카메라 동기화 | 데모까지 최단. 레퍼런스 완전 공개 | "Cesium 네이티브 라이브러리"로 보기 애매 — 심사 리스크 | Potree cesium_retz.html ★ |

→ **결정은 Phase 1 baseline 측정 후.** baseline(naive 로드)으로 4축 어디가 먼저 터지는지 보고, 그 데이터로 A/C를 고른다.

## 갭 최종 확인 (2026-06-16)

"오픈소스 + Cesium + COPC 조립품"이 정말 없는지 4갈래로 집요하게 재검증 → 전부 같은 결론.

| 경로 | 결과 |
|------|------|
| npm `copc cesium` | COPC↔Cesium 패키지 **없음** (`copc` 데이터 lib + cesium들뿐) |
| GitHub `copc cesium` | 결과 **딱 1개** → `endofcap/COPC_Cesium_Plugin` |
| └ 그 1개 정체 | **빈 껍데기** — 코드 0줄, README 90B(제목+한 줄), 같은 날 3분 4커밋 후 방치 |
| CesiumJS 네이티브 | COPC 직접 지원 **없음** (변환 필요) |
| 열린 조립품 | Potree/Giro3D/iTowns/deck.gl — **전부 Cesium 아님** |

→ **갭 확정.** 빌딩블록(copc.js·CesiumJS·laz-perf)도, 다른 엔진 조립품(Potree 등)도 다 열려 있으나,
**Cesium 렌더 통합 반쪽**만 비어 있다. 그 유일한 동명 repo조차 *"이름만 있고 알맹이 없음"* — 남들도 갭은 보지만 안 만든다(= 인식 ≠ 실행, "딸깍으론 안 나옴"의 방증).
신뢰도: 매우 높음(다른 이름/모노레포 매몰까지 100% 배제는 불가하나 모든 발견 경로가 동일 귀결).

## 출처
- https://github.com/endofcap/COPC_Cesium_Plugin (빈 스텁 — 갭의 증거)
- https://gitlab.com/giro3d/giro3d/-/merge_requests/750 (Giro3D COPC 구현)
- https://giro3d.org/latest/apidoc/classes/sources.COPCSource.html
- https://github.com/potree/potree/blob/develop/examples/copc.html
- https://github.com/potree/potree.github.io/blob/master/potree/examples/cesium_retz.html
- https://copc.io/software.html
- https://community.cesium.com/t/load-entwine-point-tiles-or-copc-in-cesium-js-viewer/41643
