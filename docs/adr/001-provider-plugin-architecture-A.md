# ADR-001: 결과물 형식 = Cesium Provider 플러그인 + 아키텍처 A (on-the-fly 3D Tiles)

- **상태**: Accepted (2026-06-16)
- **근거 문서**: [PROBLEM](../PROBLEM.md) · [STRATEGY](../STRATEGY.md) · [RESULTS](../RESULTS.md) · [REFERENCES](../REFERENCES.md)

## 맥락

- 과제: COPC 점군을 **변환 없이** CesiumJS에 직접 가시화.
- 과제가 명시한 본보기: *"COG용 `TIFFImageryProvider`와 유사한 가시화 라이브러리 개발"* → **결과물 형식을 지정한 힌트.**
- Phase 1 측정([RESULTS](../RESULTS.md)):
  - naive(전량 로드 + `PointPrimitiveCollection`)는 **~2~3M점에서 무너짐** (메모리 1KB/점, 4M=3.9GB, fps 17). 지배축은 GPU가 아니라 **편의 API의 CPU·메모리 오버헤드**.
  - 데이터축(fetch/decode)은 선형(무벽).
  - 레퍼런스(deck.gl)는 **LOD 스트리밍 + 컴팩트 버퍼**로 멀쩡.
- 갭: **"오픈소스 + Cesium + COPC LOD 스트리밍"** = 부재 (3회 확인). 닫힌 타깃(Eptium/viewer.copc.io)만 존재.

## 결정

1. **결과물 = 재사용 Cesium provider 플러그인.** `CopcTileset.fromUrl(url, options)` 스타일 (TIFFImageryProvider 패턴). 일회용 앱 아님.
2. **아키텍처 = A (on-the-fly 3D Tiles).** COPC 옥트리를 **동적 `Cesium3DTileset`으로 노출**(geometricError = `spacing / 2^깊이`). Cesium SSE가 노드를 요청하면, 그 노드만 range로 읽어 **pnts로 실시간 변환**해 공급. **LOD·컬링·스트리밍 traversal은 Cesium에 위임.**
3. **기각**: B(custom primitive — Cesium이 가진 LOD를 재발명), C(Potree 오버레이 — Cesium 플러그인이 아니라 별도 렌더러, 과제 취지 위반).
4. **CRS**: proj4 + ~~`projFunc` 옵션~~ (COMPD_CS는 내부 PROJCS 추출 + 선형단위 Z 보정으로 해결됨 — `copc-core.ts`).
   - **정정(2026-06-17)**: `projFunc`(JS 함수) **드롭**. 디코드/reproject는 워커의 per-point 핫루프 → 함수를 comlink로 넘기면 점마다 async IPC 왕복(호출이 Promise화)으로 마비. 레퍼런스 검증: prior art는 **누구도 워커에 per-point 함수를 넘기지 않고 직렬화 CRS 문자열**을 쓴다(Giro3D `registerCRS(code, proj4문자열)`·Potree proj4 문자열·deck.gl 선언적 CRS·proj4 `defs`). 오버라이드가 필요하면 `sourceCrs?: string`(또는 워커-사이드 `(wkt)=>transform` 팩토리)로 후속. 현재는 파일 WKT 자동 처리로 충분(미구현).
5. **점 표현**: 컴팩트 typed buffer (점당 객체 금지 — C2 교훈).

## API 스케치

```ts
import { Viewer } from 'cesium';
import { CopcTileset } from 'copc-cesium';

const viewer = new Viewer('app');
const copc = await CopcTileset.fromUrl('https://…/autzen.copc.laz', {
  pointSize: 2,
  colorBy: 'elevation' | 'rgb' | 'classification' | 'intensity',
  maximumScreenSpaceError: 16,  // Cesium LOD 노브
  // CRS: 파일 WKT 자동. 오버라이드 필요시 sourceCrs?: string (후속 — 결정 §4 정정 참조)
});
viewer.scene.primitives.add(copc);
copc.destroy();                 // 생명주기
```

| TIFFImageryProvider (COG) | 우리 (COPC) |
|---|---|
| `fromUrl(url, options)` | `fromUrl(url, options)` |
| COG 오버뷰 = LOD | COPC 옥트리 깊이 = LOD |
| `requestImage(x,y,z)` ← Cesium 콜백 | Cesium3DTileset 노드 content 요청 ← Cesium 콜백 |
| 타일 → 2D 이미지 | 노드 → .pnts (점 묶음) |
| `imageryLayers.addImageryProvider` | `scene.primitives.add` |

> **각주(2026-06-17 정정)**: TIFFImageryProvider의 `projFunc`는 워커를 넘나드는 per-point 함수가 아니라 **빌드당 1회 호출되는 `(code)=>{project,unproject}` 팩토리**이며, 반환된 transform은 **메인스레드에서** 워커 디코드 *이후* 적용된다(워커 경계를 넘지 않음). 즉 본보기는 "per-point 함수 전달"의 예가 아니라 *팩토리 패턴*의 선례다. 우리 워크로드는 reproject가 **워커 내부** per-point라 함수형 자체가 부적합 → §4 정정대로 `sourceCrs` 문자열/워커-사이드 팩토리로 간다.

## 결과 (Consequences)

- **(+)** Cesium의 SSE/컬링/LOD/캐시 기계를 재사용 → LOD를 손코딩 안 함. 과제 형식 부합. COPC 무변환 약속 실현. `fromUrl` 단순 API로 재사용성↑.
- **(−/핵심 위험)** 3D Tiles엔 `requestImage` 같은 **깔끔한 content 공급 훅이 없다.** `Cesium3DTileset`은 보통 URL에서 content를 불러온다. → **옥트리를 동적 tileset으로 만들고 노드 content(메모리 pnts)를 실시간 공급하는 다리**를 직접 놔야 한다. **이 다리가 Phase 2의 주 엔지니어링이자, 오픈+Cesium에 아무도 안 만든 갭의 정체.**
- LOD는 위임하므로 우리 일은 **content 공급 + 디코드(워커) + 메모리 캐시**로 이동.
- 검증: Phase 1 하네스(`verify`/`sweep`/`?bench`) 재사용. 실 GPU fps는 사용자 머신에서.

## 다음

Phase 2 계획(검증기준 포함)에서 "동적 tileset content 공급" 다리의 구체 방식을 정하고 BP 조사(Cesium 3D Tiles 동적 content API, Giro3D source 정독)로 착수.
