# 학습 위키 작성 규칙

Karpathy LLM-Wiki 합성층. SoT(코드/ADR/PROGRESS)는 그대로 두고 그 위에 이해를 적는다.

## 한 페이지 = 한 개념(엔티티)

frontmatter:

```yaml
---
slug: <kebab-slug>          # 파일명과 동일
title: <사람이 읽는 제목>
status: active | stable | deprecated
last_verified: YYYY-MM-DD   # 본문을 실제로 SoT와 대조한 날
owner: copc-cesium
projects: [copc-cesium]
---
```

본문 순서: `> 한 줄` → `## 한 줄` → `## 왜(의미)` → 필요한 절 → `## 참고 (RAW 인용)`.

## 규칙

- 본문은 **의미·연결·약점**. 다른 개념은 `[[slug]]` 백링크로 연결.
- 변동 사실(파일`:line`, 상수, 수치)은 본문 금지 → `## 참고 (RAW 인용)` 에만.
- 새 `[[slug]]` 를 stub으로 걸면 `index.md` "작성 예정" 에 등록(dangling 오탐 방지).
- 건강 점검: `/wiki-lint` (dangling/orphan/stale/contradiction/volatility 5종).
- `last_verified` 는 SoT와 실제 대조했을 때만 오늘 날짜로 갱신.
