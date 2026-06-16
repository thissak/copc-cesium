# 학습 사이트 — LLM-Wiki 합성층 설계

<!-- created: 2026-06-17 -->
<!-- status: 설계 승인 대기(사용자 검토 전) -->

## 1. 문제

현재 학습 사이트(`mkdocs build`)는 `docs/*.md`를 1:1로 html로 변환한다. 그런데 `docs/`에는
두 성격의 문서가 한 트리에 섞여 있다:

- **AI 작업 문서**: `PROGRESS.md`, `CHANGELOG.md`, `adr/`, `handoff/`, `PROFILING.md` — 빽빽하고
  자주 바뀜. 프로젝트 진행을 추적하는 용도지 *공부*용이 아님.
- **사람 학습 문서**: `index.md`, `learn/01~05` — 친절하게 쓰인 학습 콘텐츠.

결과적으로 사이트의 상당 부분이 "빽빽한 작업문서를 그대로 떨군 html"이라 **읽으며 학습하기에 불친절**하다.
목표는 사이트의 얼굴을 **내가 읽기 편한 실제 학습 콘텐츠**로 바꾸는 것 — 단, `md→html`(MkDocs) 메커니즘은 그대로.

## 2. 목표 / 비목표

**목표**
- `md→html`(MkDocs Material) 변환 메커니즘은 **무변경**으로 유지.
- 내가 직접 쓰는 **LLM-Wiki 합성층**(`wiki/*.md`)을 학습 사이트의 1차 콘텐츠로 둔다.
- 합성층은 감독님 기존 wiki 규약(EtaxbookMasterLabs/DasolLabs)과 `wiki-lint` 스킬을 그대로 따른다.

**비목표 (YAGNI)**
- AI 작업 문서(ADR/PROGRESS/CHANGELOG)를 삭제하지 않는다 — 프로젝트 SSOT라 필요. 메뉴에서 뒤로 물릴 뿐.
- 자동 생성/요약 파이프라인을 만들지 않는다 — 합성층은 사람이 직접 쓴다(능동 학습).
- `memory/`(1인칭 AI 메모리)를 wiki로 옮기지 않는다 (wiki-lint 규칙).

## 3. 설계: 3층 구조

```
① SoT (사실, 자주 바뀜)
   src/ 코드, docs/adr, docs/PROGRESS, docs/CHANGELOG, docs/PROFILING
        │  내가 읽고 → 내 언어로 합성·인용
② wiki 합성층 (내가 쓰는 학습 콘텐츠)        ← 사이트의 얼굴
   wiki/*.md — 친절·연결·의미 위주, [[백링크]], 참고(RAW)에 코드:line 인용, last_verified 신선도
        │  md → html (그대로, MkDocs)
③ 학습 사이트 (html)
   왼쪽 메뉴 = 학습(index + learn + wiki)이 앞, 원본 AI문서는 "참고" 뒤로
```

핵심 전환: 사이트 메뉴의 "주인공"을 **AI 작업문서 → 학습 합성층**으로 옮긴다.

## 4. 구체 구조

| 항목 | 결정 |
|------|------|
| wiki 위치 | `wiki/` **레포 루트** (감독님 타 프로젝트·`wiki-lint`가 찾는 위치와 동일) |
| 사이트 렌더 | `docs/wiki → ../wiki` **심볼릭 링크** 1개로 MkDocs가 흡수. `md→html` 무변경 |
| 페이지 형식 | 기존 frontmatter 규약: `slug / title / status / last_verified / owner / projects` + 본문(`> 한 줄`, `## 한 줄`, 의미·`[[백링크]]`) + `## 참고 (RAW 인용)`(코드 경로·상수 등 변동성 사실은 여기에만) |
| 메뉴 순서 | `mkdocs.yml`에 `nav:` 명시 → ①학습(index, learn/, wiki/) 위, ②원본 문서(adr/progress/changelog/handoff/profiling) 아래 "참고" 섹션 |
| 유지보수 | `wiki-lint` 스킬로 dangling/orphan/stale/contradiction/volatility 점검 |

**심링크 검증 주의**: MkDocs가 심링크된 디렉토리를 따라 빌드하는지는 **구현 시 `mkdocs build`로 실제 확인**한다
(추측 금지). 따라가지 않으면 폴백: (a) 빌드 전 `wiki/`→`docs/wiki/` 복사 스텝, 또는 (b) `wiki/`를 `docs/wiki/`에
직접 두고 `wiki-lint`를 `docs/` 기준으로 실행.

## 5. `learn/` 커리큘럼과의 관계 — 공존(결정)

- `docs/learn/01~05` 선형 입문 코스는 **그대로 유지**(이미 친절히 쓰임).
- `wiki/`는 **개념별 엔티티 레퍼런스**(비선형·교차링크) 신설.
- 둘을 `[[slug]]`로 상호 연결. learn = "처음 읽는 길", wiki = "개념 그래프".
- 근거: 가장 덜 파괴적이고 기존 자산을 살림. 추후 흡수로 전환 쉬움.

## 6. 시드 계획 (첫 페이지)

본격 작성은 감독님이 학습하며 직접 채운다. 부트스트랩으로 **스캐폴드 + 예시 1장**만:

- `wiki/index.md` — 카테고리 표 + "마지막 갱신" (wiki-lint가 orphan 판정에 사용)
- `wiki/README.md` — 합성층 작성 규칙 한 장 (기존 프로젝트 README 톤)
- `wiki/decode-on-main-thread.md` — **예시 1장**. (이번 세션에서 만든 "디코드가 왜 메인스레드에서
  도는가" 설명을 합성층 형식으로 옮김. 본문=의미, 참고(RAW)=`copc-tileset.ts:48` `copc-core.ts:149`
  `public/copc-sw.js`, 백링크=`[[service-worker-tile-interception]]` `[[copc-octree-lod-streaming]]`(stub))

## 7. 검증 기준 (Acceptance Criteria)

- [ ] `wiki/`가 레포 루트에 존재하고 `wiki/index.md`가 있다 (`wiki-lint` Step 0 통과).
- [ ] `mkdocs build`(= `/docsite build`)가 에러 없이 끝나고, `site/`에 `wiki/` 페이지의 html이 생성된다.
- [ ] 사이트 좌측 메뉴에서 학습 콘텐츠(index/learn/wiki)가 원본 AI문서(adr/progress/changelog)보다 **위**에 온다.
- [ ] 시드 페이지 `wiki/decode-on-main-thread.md`가 frontmatter 규약을 충족하고, 본문에 파일:line 같은 변동성 사실이 없으며(참고 섹션에만), `[[백링크]]`를 포함한다.
- [ ] `wiki-lint` 실행 시 시드 세트에 대해 dangling(의도된 stub 제외)·contradiction 0건으로 보고된다.

## 8. 테스트 시나리오

- **정상**: `mkdocs build` → `site/wiki/decode-on-main-thread/index.html` 생성, 좌측 nav에 "학습 > 디코드는 어디서 도는가" 노출.
- **엣지**: `wiki/`에 새 `[[copc-octree-lod-streaming]]` 링크가 아직 stub일 때 → `wiki-lint`가 "의도된 stub"으로 구분하고 dangling 오탐을 내지 않는다.
- **실패**: 심링크를 MkDocs가 못 따라감 → 빌드 산출물에 `wiki/` 없음을 빌드 로그/`site/` 확인으로 즉시 감지하고 §4 폴백으로 전환.
