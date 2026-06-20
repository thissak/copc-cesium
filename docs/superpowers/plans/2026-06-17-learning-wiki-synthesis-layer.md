# 학습 사이트 LLM-Wiki 합성층 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 빽빽한 AI 작업문서가 그대로 떨어지던 학습 사이트를, 내가 직접 쓰는 친절한 LLM-Wiki 합성층(`wiki/*.md`)이 얼굴이 되도록 바꾼다. `md→html`(MkDocs) 메커니즘은 무변경.

**Architecture:** `wiki/`를 레포 루트에 두어 `wiki-lint` 규약을 그대로 따르고, `docs/wiki` 심링크 1개로 MkDocs가 html로 흡수한다. `mkdocs.yml`에 명시 `nav:`를 추가해 학습 콘텐츠(index/learn/wiki)를 앞, 원본 AI문서를 "참고" 섹션 뒤로 보낸다.

**Tech Stack:** MkDocs Material (기존), 감독님 wiki frontmatter 규약, `wiki-lint` 스킬.

## Global Constraints

- `md→html` 변환 메커니즘(MkDocs)은 변경하지 않는다. 새 플러그인/의존성 추가 금지(명시 `nav:`로 충분).
- `wiki/`는 **레포 루트**에 둔다 (`wiki-lint` Step 0가 `./wiki/index.md`를 찾음). `docs/` 밑에 직접 두지 않는다.
- wiki 본문에는 변동성 높은 사실(파일`:line`, 상수, TTL, 숫자)을 박지 않는다 — `## 참고 (RAW 인용)` 섹션에만.
- frontmatter 키 = `slug / title / status / last_verified / owner / projects` (기존 프로젝트와 동일).
- AI 작업문서(ADR/PROGRESS/CHANGELOG/handoff/PROFILING)는 **삭제 금지** — 메뉴에서 뒤로 물릴 뿐.
- 커밋은 **사용자 승인 시에만** 실행한다(이 프로젝트 규칙). 각 Task의 commit 스텝은 승인 후 진행.
- 날짜 리터럴: 오늘 = `2026-06-17`.

---

### Task 1: `wiki/` 스캐폴드 (index + README)

**Files:**
- Create: `wiki/index.md`
- Create: `wiki/README.md`

**Interfaces:**
- Produces: `wiki/index.md` (wiki-lint Step 0 진입점 + orphan 판정용 카테고리 표, stub 등록), `wiki/README.md` (작성 규칙).

- [ ] **Step 1: `wiki/index.md` 작성**

```markdown
# CopcCesiumLab 학습 위키

> 코드·ADR·PROGRESS(SoT)를 읽고 **내 언어로 합성한 학습 층**. 사본이 아니라 의미·연결·약점을 적는다.
> 구체 수치/파일 경로는 본문이 아니라 각 페이지의 `## 참고 (RAW 인용)` 에만 둔다.

마지막 갱신: 2026-06-17

## 개념 페이지

| slug | 한 줄 | status |
|------|-------|--------|
| [[decode-on-main-thread]] | 디코드는 SW가 아니라 페이지 메인스레드에서 돈다 | active |

## 작성 예정 (stub — 의도된 미작성)

- `service-worker-tile-interception` (아직 없음) — SW가 타일 요청을 가로채 페이지로 라우팅
- `copc-octree-lod-streaming` (아직 없음) — Cesium 위임 LOD로 옥트리 노드 스트리밍

작성 규칙은 [README](README.md) 참고.
```

- [ ] **Step 2: `wiki/README.md` 작성**

```markdown
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
projects: [CopcCesiumLab]
---
```

본문 순서: `> 한 줄` → `## 한 줄` → `## 왜(의미)` → 필요한 절 → `## 참고 (RAW 인용)`.

## 규칙

- 본문은 **의미·연결·약점**. 다른 개념은 `[[slug]]` 백링크로 연결.
- 변동 사실(파일`:line`, 상수, 수치)은 본문 금지 → `## 참고 (RAW 인용)` 에만.
- 새 `[[slug]]` 를 stub으로 걸면 `index.md` "작성 예정" 에 등록(dangling 오탐 방지).
- 건강 점검: `/wiki-lint` (dangling/orphan/stale/contradiction/volatility 5종).
- `last_verified` 는 SoT와 실제 대조했을 때만 오늘 날짜로 갱신.
```

- [ ] **Step 3: 파일 존재 + wiki-lint Step 0 조건 검증**

Run: `ls wiki/index.md wiki/README.md && test -f wiki/index.md && echo "WIKI-OK"`
Expected: 두 경로 출력 + `WIKI-OK`

- [ ] **Step 4: Commit (사용자 승인 후)**

```bash
git add wiki/index.md wiki/README.md
git commit -m "docs: 학습 위키 합성층 스캐폴드(index+README)"
```

---

### Task 2: `docs/wiki` 심링크 + MkDocs 흡수 검증

**Files:**
- Create (symlink): `docs/wiki` → `../wiki`

**Interfaces:**
- Consumes: Task 1의 `wiki/index.md`.
- Produces: 빌드 산출물 `site/wiki/index.html` (이후 Task의 nav/시드가 의존).

- [ ] **Step 1: 상대 심링크 생성**

```bash
ln -s ../wiki docs/wiki
```

- [ ] **Step 2: 심링크 확인**

Run: `test -L docs/wiki && ls docs/wiki/index.md && echo "SYMLINK-OK"`
Expected: `docs/wiki/index.md` 출력 + `SYMLINK-OK`

- [ ] **Step 3: 빌드해서 MkDocs가 심링크를 따라가는지 검증 (추측 금지 — 실제 확인)**

Run: `/docsite build`  (또는 mkdocs가 PATH에 있으면 `mkdocs build`)
그 다음: `ls site/wiki/index.html && echo "RENDER-OK"`
Expected: `site/wiki/index.html` 존재 + `RENDER-OK`

- [ ] **Step 4: (Step 3 실패 시에만) 폴백 적용**

`site/wiki/` 가 생성되지 않으면 MkDocs가 심링크 디렉토리를 안 따라간 것이다. 폴백:
1. 심링크 제거: `rm docs/wiki`
2. 빌드 전 복사 스텝 사용 — `package.json` 또는 docsite 호출 전에 `rm -rf docs/wiki && cp -R wiki docs/wiki` 를 끼운다(생성물이므로 `.gitignore` 에 `docs/wiki/` 추가).
3. 다시 Step 3 검증.

폴백을 썼다면 이 plan의 §Task 2 결과 줄에 어떤 경로를 택했는지 한 줄 기록.

- [ ] **Step 5: Commit (사용자 승인 후)**

```bash
git add docs/wiki   # 심링크 경로. 폴백 시 .gitignore 변경분 포함
git commit -m "build: wiki/ 를 docs/wiki 심링크로 MkDocs 에 노출"
```

---

### Task 3: `mkdocs.yml` 명시 nav — 학습 앞, 원본 문서 뒤

**Files:**
- Modify: `mkdocs.yml` (현재 `nav:` 없음 → 추가)

**Interfaces:**
- Consumes: `docs/wiki/index.md`(심링크), 기존 `learn/`·원본 문서들.
- Produces: 좌측 메뉴 순서 — 홈 → 학습(커리큘럼+위키) → 참고(원본 문서).

- [ ] **Step 1: `mkdocs.yml` 끝에 nav 블록 추가**

기존 주석(`# nav: 생략 …`)을 지우고 아래로 교체:

```yaml
nav:
  - 홈: index.md
  - 학습:
      - 커리큘럼:
          - learn/index.md
          - learn/01-point-clouds.md
          - learn/02-copc.md
          - learn/03-cesiumjs.md
          - learn/04-coordinate-systems.md
          - learn/05-copc-cesium-integration.md
      - 위키:
          - wiki/index.md
          - wiki/decode-on-main-thread.md
  - "참고 (원본 문서)":
      - 문제정의: PROBLEM.md
      - 전략: STRATEGY.md
      - 진행상태: PROGRESS.md
      - 변경이력: CHANGELOG.md
      - 프로파일링: PROFILING.md
      - 결과: RESULTS.md
      - 레퍼런스: REFERENCES.md
      - "설계결정 (ADR)":
          - adr/001-provider-plugin-architecture-A.md
          - adr/002-service-worker-tile-interception.md
      - 핸드오프:
          - handoff/phase2-streaming-handoff.md

# 빌드 산출물/메타 문서는 메뉴에서 제외(빌드 경고 억제)
not_in_nav: |
  /superpowers/*
  /wiki/README.md
```

> 주의: `wiki/decode-on-main-thread.md` 는 Task 4에서 생성한다. nav에 먼저 등록해도 빌드는
> 경고만 내고 통과하지만, 깔끔하게 하려면 Task 4 완료 후 본 Task의 검증을 함께 돌린다.

- [ ] **Step 2: 빌드 + 순서 검증**

Run: `/docsite build` (또는 `mkdocs build`)
그 다음: `grep -o 'href="[^"]*PROGRESS[^"]*"' site/index.html | head -1`
Expected: 빌드 성공. 생성된 좌측 nav에서 "학습" 섹션이 "참고 (원본 문서)" 섹션보다 먼저 등장(육안 또는 아래 보조 검증).

보조 검증(순서): `python3 -c "import re,sys; h=open('site/index.html').read(); a=h.find('학습'); b=h.find('참고 (원본 문서)'); print('ORDER-OK' if 0<=a<b else 'ORDER-FAIL', a, b)"`
Expected: `ORDER-OK`

- [ ] **Step 3: Commit (사용자 승인 후)**

```bash
git add mkdocs.yml
git commit -m "docs: 사이트 메뉴 재배치 — 학습(위키/커리큘럼) 앞, 원본 문서 뒤"
```

---

### Task 4: 시드 위키 페이지 — `decode-on-main-thread`

**Files:**
- Create: `wiki/decode-on-main-thread.md`

**Interfaces:**
- Consumes: Task 1의 `wiki/index.md`(여기에 이미 `[[decode-on-main-thread]]` 등록됨), Task 2 렌더 경로.
- Produces: 합성층 첫 실증 페이지(이후 감독님이 같은 형식으로 증식).

- [ ] **Step 1: 페이지 작성 (본문=의미, 참고=RAW 인용)**

```markdown
---
slug: decode-on-main-thread
title: 디코드는 어디서 도는가 — 서비스워커 vs 메인스레드
status: active
last_verified: 2026-06-17
owner: copc-cesium
projects: [CopcCesiumLab]
---

# 디코드는 어디서 도는가

> 서비스워커는 **네트워크만 가로채는 라우터**고, 진짜 포인트클라우드 디코드(WASM + 좌표변환)는 **페이지 메인스레드**에서 돈다. SW 스레드와 디코드 스레드가 다르다.

## 한 줄

Cesium이 노드를 요청하면 [[service-worker-tile-interception]] 가 fetch를 가로채 페이지로 메시지를 던지고, 페이지가 그 노드만 디코드해 pnts로 돌려준다. 가로채기는 SW 스레드, **디코드는 메인스레드**.

## 왜 메인스레드인가 (의미)

핵심은 **상태가 어디 사는가**다. laz-perf WASM 인스턴스와 열린 COPC 세션(좌표변환기 포함)은 페이지 모듈 스코프에 산다. 서비스워커는 자기 라이프사이클상 언제든 종료될 수 있어 이 무거운 세션 상태를 들고 있기 곤란하다. 그래서 SW는 "가로채서 세션이 사는 페이지로 되던지는" 라우터 역할만 하고, 디코드 실체는 세션이 있는 메인스레드로 돌아온다.

## 비용이 어디로 떨어지나 (약점)

- **좋은 점**: 네트워크 가로채기·라우팅은 SW 스레드라 메인스레드를 막지 않는다.
- **부담**: 점마다 좌표 재투영하는 디코드 루프와 WASM 디코드가 **Cesium 렌더 루프와 같은 메인스레드**에서 돈다. 노드가 크거나 여러 노드가 동시에 들어오면 프레임을 갉아먹는다. 색 계산 루프도 동일.
- 떼어내려면 Web Worker 풀 위임이 자연스러운 후보지만 — 워커 풀은 프로젝트 STOP 규칙 대상(prior art 조사 후 착수). 여기선 "현상" 까지만.

연결: [[service-worker-tile-interception]] · [[copc-octree-lod-streaming]]

## 참고 (RAW 인용)

- 페이지 메시지 핸들러 + 디코드 호출: `src/copc-tileset.ts` (`installHandler`, `nodeToPnts`)
- 노드 디코드 본체(WASM 디코드 + 좌표 재투영 루프): `src/copc-core.ts` (`decodeNode`)
- fetch 가로채기 + MessageChannel 라우팅: `public/copc-sw.js` (`/__copc-real/*`)
- 배경 결정: ADR-002 (서비스워커 타일 가로채기)
```

- [ ] **Step 2: frontmatter·백링크·변동성 검증**

Run: `grep -q '^slug: decode-on-main-thread' wiki/decode-on-main-thread.md && grep -q '\[\[service-worker-tile-interception\]\]' wiki/decode-on-main-thread.md && echo "FRONT-LINK-OK"`
Expected: `FRONT-LINK-OK`

본문 변동성(파일:line 미포함) 확인 — `## 참고` 위쪽 본문에 `.ts:` 패턴이 없어야 한다:
Run: `awk '/^## 참고/{exit} /\.ts:[0-9]/{print "VOLATILE-IN-BODY"}' wiki/decode-on-main-thread.md; echo done`
Expected: `VOLATILE-IN-BODY` 출력 없이 `done` 만.

- [ ] **Step 3: wiki-lint 점검 (dangling 의도 stub 제외 / contradiction 0)**

`/wiki-lint` 실행 → 리포트에서:
- dangling: `service-worker-tile-interception`, `copc-octree-lod-streaming` 는 index "작성 예정"에 등록돼 **의도된 stub**으로 분류(오탐 아님).
- contradiction: 0건.
Expected: 위 2개 외 dangling 0, contradiction 0.

- [ ] **Step 4: 최종 빌드 (Task 3 nav와 함께)**

Run: `/docsite build` → `ls site/wiki/decode-on-main-thread/index.html && echo "SEED-RENDER-OK"`
Expected: `SEED-RENDER-OK`

- [ ] **Step 5: Commit (사용자 승인 후)**

```bash
git add wiki/decode-on-main-thread.md wiki/index.md
git commit -m "docs: 시드 위키 페이지 — 디코드는 어디서 도는가(메인스레드)"
```

---

## 완료 후 검증 (spec Acceptance Criteria 대조)

- [ ] `wiki/index.md` 존재 → wiki-lint Step 0 통과 (Task 1)
- [ ] `mkdocs build` 성공 + `site/wiki/*` html 생성 (Task 2/4)
- [ ] 좌측 메뉴: 학습 > 참고 순서 (Task 3, ORDER-OK)
- [ ] 시드 페이지 frontmatter·백링크 충족, 본문에 변동성 사실 없음 (Task 4)
- [ ] wiki-lint: 의도 stub 외 dangling 0, contradiction 0 (Task 4)
