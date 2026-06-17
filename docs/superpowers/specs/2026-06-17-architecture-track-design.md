# 학습 사이트 — "아키텍처: 코드로 읽는 설계" 트랙 설계

<!-- created: 2026-06-17 -->
<!-- status: 승인됨 (사용자 승인 2026-06-17) -->

## 1. 문제

현재 학습 사이트는 `docs/*.md`를 MkDocs로 **수동 변환**한다. `learn/01~07`(개념 배경)과
`wiki/`(깊은 메커니즘 2편)은 있지만, **우리 시스템의 설계 자체를 큰 그림 → 디테일로,
실제 코드와 다이어그램으로 따라가는 통합 트랙은 없다.**

목표는 md→html 변환이 아니라 **적극적 콘텐츠 제작** — 독자(프로젝트 오너 본인)가 이 시스템을
코드 레벨까지 파악하도록 새로 집필한다.

## 2. 목표 / 비목표

**목표**
- `docs/arch/` 새 트랙: `CopcTileset.fromUrl()` 뒤의 설계를 큰 그림 → 디테일로 집필.
- 다이어그램(mermaid) 적극 사용 + 실제 `src/` 코드 짧은 인용·해설.
- learn/(개념)·wiki/(깊은 메커니즘)와 **공존**, 중복은 링크로 연결.

**비목표 (YAGNI)**
- MkDocs 빌드 메커니즘 변경 없음 (md→html 그대로).
- learn/01~07 재작성·삭제 없음 (개념 배경으로 유지).
- 좌표계 변환·pnts 양자화를 별도 페이지로 분리하지 않음 — 각각 06·03 본문에 둠
  (요청 시 심화 페이지로 승격).

## 3. 독자·집필 원칙

- **독자**: 프로젝트 오너. C++ 약간 알지만 JS/TS는 약함.
- **C++ 비교는 기본적으로 쓰지 않는다** (사용자 요청). 개념을 한국어로 직접 설명.
- 낯선 JS/TS 관용구(`Promise.all`, transferable zero-copy, comlink proxy, `data:` URL,
  서비스워커)는 그 자리에서 1–2줄로 직접 풀어 설명.
- 실제 `src/` 코드를 **짧게 인용**(전체 덤프 금지) + 한국어 해설. 경로는 `src/x.ts:line` 형태.
- 추측 금지 — 코드에 있는 사실만. 변동 가능 수치는 본문에 단정하지 않는다.

## 4. 배치 / 메뉴

- 새 폴더 `docs/arch/`. `mkdocs.yml` nav 의 `학습` 아래 **커리큘럼과 위키 사이**에 `아키텍처` 섹션.
- nav 는 페이지를 집필한 만큼 **증분 등록**(없는 파일 링크로 인한 빌드 경고 방지).

## 5. 마스터 다이어그램 (00 페이지 앵커 — 한 요청의 일생)

```
Cesium → ① /__copc-real/{sid}/{key}.pnts → 서비스워커
서비스워커 → ② postMessage(MessageChannel) → 페이지
페이지 → ③ decode(sid,key) → Web Worker
Web Worker ↔ ④ Range GET(그 노드 바이트만) ↔ COPC 원본
Web Worker → ⑤ pnts(zero-copy) → 페이지 → ⑥ → 서비스워커 → ⑦ 응답 → Cesium 렌더
```

각 화살표(①~⑦)가 한 페이지의 주제가 된다.

## 6. 페이지 구성 (index + 00~06)

| # | 파일 | 한 줄 | 핵심 코드 인용 | 근거 |
|---|------|-------|---------------|------|
| — | `index.md` | 트랙 소개 + 읽는 순서 + learn/wiki 와의 관계 | — | — |
| 00 | `00-big-picture.md` | 한 요청의 일생(시퀀스 전체) | `copc-sw.js`, `copc-tileset.ts` installHandler | — |
| 01 | `01-public-api-and-isomorphism.md` | URL→Tileset 한 줄, 옥트리↔3D Tiles, `GE=spacing/2^깊이` | `index.ts`, `copc-tileset.ts` fromUrl, `tileset.ts` nodeRegionAndError | ADR-001 |
| 02 | `02-service-worker.md` | Cesium은 COPC를 모른다 → SW가 URL 요청 가로채 페이지로 | `copc-sw.js`, ensureServiceWorker, installHandler | ADR-002 |
| 03 | `03-worker-decode.md` | comlink RPC, laz-perf(WASM), zero-copy pnts | `decode.worker.ts`, `copc-core` decodeNode, `pnts-quantized.ts` | wiki/decode-in-worker |
| 04 | `04-lod-delegation.md` | SSE가 "언제 어느 노드"를 결정 — 손코딩 안 함 | `tileset.ts` buildTileset, fromUrl LOD 노브 | ADR-001·004 |
| 05 | `05-hierarchy-paging.md` | 서브페이지 proxy → 본 만큼만 lazy 확장, "깊이의 벽" | `tileset.ts` pageProxy/buildSubtree, buildPageTileset, loadSubPage | ADR-003, wiki/hierarchy-subpage-paging |
| 06 | `06-production-core.md` | 4기둥: 생명주기·복원력·정확성(좌표)·속성(colorBy) | releaseSession, httpGetterWithRetry, extractHorizontalCrs, `colors.ts` | learn/06 |

## 7. 페이지마다 같은 리듬

1. 한 줄 + 위치 다이어그램 (마스터 그림 중 이 페이지 위치)
2. 무슨 문제를 푸나
3. 어떻게 — 다이어그램 + 실제 코드 스니펫(`src/x.ts:line`)
4. 왜 이렇게 — ADR/wiki 링크
5. (선택) 작게 확인 — 미니 코드/실험

## 8. 검증 기준 (Acceptance Criteria)

- [ ] `mkdocs build`가 무경고(새 페이지 broken-link 0)로 통과
- [ ] 새 페이지 전부 좌측 `학습 > 아키텍처` 섹션에 노출
- [ ] 각 페이지에 실제 코드 위치 ≥1 인용 + 다이어그램 ≥1
- [ ] 00 페이지에 end-to-end 시퀀스 다이어그램 포함
- [ ] ADR/wiki/learn 교차링크가 빌드에서 정상 해소
- [ ] 로컬 serve에서 모든 mermaid 다이어그램 렌더(깨짐 0)

## 9. 진행 방식

페이지별 검토(승인된 cadence): index+00 먼저 → 피드백 → 01 → 02 → ... → 06.
각 페이지 집필 후 nav 증분 등록 + `mkdocs build` 무경고 확인.
