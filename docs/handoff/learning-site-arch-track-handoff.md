# 학습 사이트 — 아키텍처 트랙 Handoff

<!-- 2026-06-18 -->

## 완료된 작업
- `docs/arch/` 새 트랙 **index + 00~06** 집필 — `CopcTileset.fromUrl()` 뒤 설계를 큰그림→디테일로,
  매 페이지 mermaid 다이어그램 + 실제 `src/` 코드 인용 + ADR/wiki 교차링크.
- `mkdocs.yml` nav 에 `학습 > 아키텍처` 섹션 등록 (커리큘럼과 위키 사이).
- mini-sim 타이포 매칭 `docs/stylesheets/extra.css` (`extra_css`).
- 한글 헤딩 앵커 깨짐 fix — `toc.slugify` 를 유니코드(pymdownx)로 교체.
- 검증: `mkdocs build --strict` 무경고 · arch 앵커·링크 불일치 0 · 8페이지 mermaid 렌더.
- 설계 스펙: `docs/superpowers/specs/2026-06-17-architecture-track-design.md`.

## 다음 작업
- 사용자 **내용 검토** (페이지별 톤·깊이·코드 분량). 검토 cadence = 페이지별.
- **(결정 대기) 렌더러** — mini-sim 과 픽셀 단위로 동일한 다크 GitHub 3단 룩을 원하면
  `SimLab/mini-sim/rebuild/study/build_html.py` 파이썬 생성기를 이식한다(CSS·3단 쉘·다크토글·
  mermaid·링크 재작성은 범용이라 재사용, `build_nav`/`render_index` 만 우리 구조로 재작성).
  콘텐츠 `.md` 는 렌더러 독립 — 그대로 재사용.

## 알려진 이슈
- MkDocs Material 은 mini-sim 의 커스텀 다크 GitHub 3단 룩과 chrome(상단 헤더·탭·nav DOM·폰트 로딩)이
  달라, CSS 오버라이드로는 **근사치까지만** 가능 (uncanny valley).
- 00 의 `①③` 동그라미 숫자 헤딩은 슬러그가 렌더러마다 다르다(파이썬 `github_slugify` 는 `①` 제거,
  pymdownx 는 보존). 해당 3개 교차링크는 섹션 앵커 대신 **페이지 링크**로 두어 양쪽에서 안정.

## 핵심 결정 사항
- 트랙 배치 = **learn(개념)·arch(설계)·wiki(깊은 메커니즘) 공존**, 새 트랙 *추가*(기존 재편 아님).
- 집필 = 수동 md→html 변환이 아닌 **적극적 교육 콘텐츠 제작**. 독자=오너 본인, C++ 비교 없이 JS/TS 직접 설명.
- 렌더러 = **미결** (MkDocs 유지 vs 파이썬 생성기 이식).
