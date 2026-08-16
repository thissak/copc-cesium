# 2026 오픈소스 개발자대회 — 시연영상 handoff

**작성**: 2026-08-16 (Windows 재구축 세션)
**마감**: 2026-08-27 18:00
**이 문서는 gitignore 대상** (`docs/handoff/2026-submission-video-handoff.md`). 로컬 보존용.

---

## 0. 왜 다시 만들었나

2026-08-09 에 167초 최종본을 완성했으나, 그 산출물 일체(`docs/submission/`, 영상 handoff)가
**전부 .gitignore 대상**이라 이 Windows 체크아웃에는 남아 있지 않다. D 드라이브·문서·다운로드·바탕화면
전수 검색 0건. → **처음부터 재제작**으로 결정(감독님 승인, 2026-08-16).

> 교훈: 영상 원본은 커밋하지 않더라도 **대본·샷리스트·제작 스크립트는 추적 대상**이어야 한다.
> 이번엔 `scripts/video/record.ts` 를 repo 에 두어 재현 가능하게 했다.

---

## 1. 파이프라인 (Windows 신규 구축 완료)

| 구성요소 | 상태 | 비고 |
|---------|------|------|
| ffmpeg | 9.0 (winget `Gyan.FFmpeg`, user scope) | PATH 미갱신 셸 대비해 스크립트가 `%LOCALAPPDATA%/Microsoft/WinGet/Links/` 도 훑는다 |
| edge-tts | 설치됨 (`pip install --user edge-tts`) | 한국어 뉴럴 3종: `ko-KR-SunHiNeural`(여), `ko-KR-InJoonNeural`(남), `ko-KR-HyunsuMultilingualNeural`(남) |
| Playwright chromium | 1228 (149.0.7827.55) | 기존 1217 과 불일치해 재설치 필요했음 |
| Cesium ion 토큰 | `.env` 의 `VITE_CESIUM_ION_TOKEN` | scope `assets:read`. 위성영상+지형 베이스맵 동작 확인 |

**GPU**: 헤드리스에서도 실 GPU 가 붙는다 — `ANGLE (NVIDIA RTX 4090, D3D11)`.
헤드풀은 `page.screenshot()` 마다 뷰포트를 리사이즈해 **화면이 깜빡이므로 쓰지 않는다**(실사용 중 확인).

### 기각한 경로
- **ddagrab** (Desktop Duplication, Game Bar 와 같은 원리): `hwdownload,format=bgra` 를 넣으면 캡처 자체는
  된다. 다만 전체화면 점유가 필요해 감독님 판단으로 중단.
- **Game Bar**: 화질은 최상이나 Win+Alt+R 단축키 전용이라 **자동화 불가**. 샷마다 수동 개입 필요.
- **gdigrab**: 동작은 하나 ddagrab 중단과 함께 미채택.

---

## 2. 녹화 방식 — 하이브리드 (감독님 승인)

`scripts/video/record.ts` 가 두 모드를 쓴다.

| 모드 | 방식 | 쓰는 곳 | 화면 FPS 카운터 |
|------|------|---------|----------------|
| `offline` | 프레임 단위로 카메라 전진 → JPEG q95 캡처 → ffmpeg H.264 CRF16 **30fps** | 로딩이 끝난(settled) 오빗·미관 샷 | **끈다** |
| `realtime` | Playwright `recordVideo` (VP8 25fps, ~1.7Mbps) | LOD 가 채워지는 스트리밍 샷 | 켠다 |

**FPS 카운터를 오프라인 샷에서 끄는 이유**: 프레임 단위 캡처 중에는 Cesium 의 FPS 표시가 실제 60 이 아니라
캡처 속도(~9)를 찍는다. 그대로 두면 **성능을 실제보다 낮게 보이게 왜곡**한다. HUD(노드 수·로드 시간)는
사실이므로 남긴다.

**실시간 샷을 오프라인으로 바꾸지 말 것**: 스트리밍 장면은 속도 자체가 주장이다. 프레임 단위로 찍으면
벽시계와 분리돼 실제 버퍼링 속도와 무관한 그림이 된다.

캡처 속도 실측: 헤드리스 JPEG q95 = **72ms/프레임(≈13.9fps)**. 20초 샷 ≈ 45초.

---

## 3. 샷 리스트

| 샷 | 데이터 | 길이 | 모드 | 의도 |
|----|--------|------|------|------|
| `autzen-orbit-rgb` | Autzen (77MB) | 20s | offline | 대표 예제. 원본 RGB 로 "변환 없이 바로 뜬다" |
| `autzen-orbit-class` | Autzen | 16s | offline | 표준 `Cesium3DTileStyle` 이 그대로 먹는다는 증거(분류색) |
| `autzen-dive-lod` | Autzen | 18s | realtime | 줌인하며 LOD 가 채워지는 실제 스트리밍 |
| `sofi-orbit` | SoFi Stadium (1.9GB) | 20s | offline | 대형 데이터를 사전 변환 없이 |
| `sofi-dive-lod` | SoFi Stadium | 20s | realtime | 대형 데이터의 실제 스트리밍 속도 |
| `autzen-pick` | Autzen | 16s | realtime | **점 조회** — 클릭 시 좌표·LAS 속성·옥트리 최근접점(snap). 경쟁작 대비 구조적 우위 |

> 실시간 샷은 **초기 로딩이 끝난 뒤부터** 카메라를 움직인다. 안 그러면 앞부분이 빈 지구본(올리브색)만 나온다.
> 경로 시작 시각은 `raw/clips.json` 에 자동 기록돼 `build.ts` 가 인 포인트로 쓴다 — 빈 구간을 눈으로 찾지 않는다.

출력: `docs/submission/video/assets/raw/<shot>.{mp4,webm}` (gitignore)

재촬영: `npm run dev` 후 `npx tsx scripts/video/record.ts [샷이름…]`

---

## 4. 이번 세션에서 고친 결함

시연 화면을 실제로 보면서 발견 → 이슈 문서화 → 해결.

| 이슈 | 문제 | 결과 |
|------|------|------|
| [#28](../issues/28-zoomto-frames-octree-cube.md) | `zoomTo` 가 옥트리 큐브(고도 833m)를 조준해 점군이 화면 아래로 밀림 | cy 0.844 → **0.569**, 점유율 13.9% → 18.3% |
| [#29](../issues/29-run-checks-windows-spawn.md) | Windows 에서 `npm test` 가 0/9 (러너가 `.cmd` 셰임 spawn) | **unit 9/9 · integration 9/9** |
| [#30](../issues/30-elevation-ramp-collapsed-by-outliers.md) | 노이즈 몇 점이 고도 램프를 무너뜨려 SoFi 가 전면 초록 단색 | hue 스팬 50° → **170°** |
| [#31](../issues/31-hud-node-count-stale-snapshot.md) | HUD 노드 수가 +4초 스냅샷에 고착 — s8 이 "노드 0" 으로 주장을 반증 | SoFi 0 → **78** (실제와 일치) |
| [#32](../issues/32-pick-panel-blocked-by-snap.md) | 클릭 패널이 느린 `snapPoint` 를 기다려 5~6초 무반응 | **1.5초에 표시** |

#30·#31·#32 는 **이웃 세션 교차검토**에서 발견됐다(§7). 특히 #31·#32 는 영상 문제가 아니라
**제품(데모) 자체의 결함**이었고, 증상을 가리지 않고 근본원인까지 간 것이 결과적으로 데모를 고쳤다.

#28 은 ADR-007 R14 의 타일 완전포함 계약을 건드리지 않고, 조준용 구
`tileset.copcPointBoundingSphere` 를 **추가로 노출**하는 방식으로 풀었다. 공개 API 변경이므로
README 반영 여부를 확인할 것.

브랜치: `fix/28-zoomto-frames-octree-cube` (두 이슈 동승, 파일이 겹치지 않아 커밋 분리 가능)

---

## 5. 영상 제작 파이프라인 (완성)

```bash
npm run dev                          # dev 서버 (녹화용)
tsx scripts/video/record.ts          # 1) 원본 클립 5개
tsx scripts/video/tts.ts             # 2) 나레이션 10구간 + durations.json
tsx scripts/video/build.ts           # 3) 카드·자막·터미널 합성 → 최종 mp4
```

| 파일 | 역할 |
|------|------|
| `scripts/video/sections.ts` | **대본 SSOT** — 나레이션·자막·화면 소스. 편집은 여기만 고친다 |
| `scripts/video/cards.ts` | 정지 카드 HTML(타이틀·API·아키텍처·아웃트로) + 터미널 렌더 |
| `scripts/video/record.ts` | 실제 앱 녹화 (offline/realtime 하이브리드) |
| `scripts/video/tts.ts` | edge-tts 나레이션 합성 + 길이 측정 |
| `scripts/video/build.ts` | 최종 합성 |

**타이밍 원칙**: 나레이션 길이가 구간 길이를 정한다(`구간 = 나레이션 + 0.55s`).
오디오도 같은 길이로 패딩하므로 이어붙이면 A/V 가 자동으로 맞는다. 화면을 먼저 정하고 나레이션을 욱여넣지 않는다.

### 최종본 (2026-08-16)
- `docs/submission/video/copc-cesium-demo.mp4`
- **2분 59초** · 1920×1080 · 30fps · H.264 + AAC 48kHz 스테레오
- 나레이션 `ko-KR-InJoonNeural` rate +8% (합계 172초)
- **12구간**: 문제 → COPC → API → 스타일 → **점 조회** → 아키텍처 → 스트리밍 → 대형데이터 →
  대형스트리밍 → 검증(터미널) → **측정 수치** → 아웃트로
- YouTube: https://youtu.be/g3pzx97skDU

> 길이를 3분에 맞추려 내용을 늘리지 않았다(감독님 지시). 나레이션이 끝나는 지점이 영상이 끝나는 지점이다.

### 검증 구간의 원칙
`docs/submission/video/assets/verify-output.txt` 는 **실제 `npm test` / `test:integration` 출력**이다.
터미널 화면은 그 파일의 줄을 **가공 없이** 한 줄씩 드러낸다. 문구를 손으로 쓰지 않는다 — 재현하려면
검증을 다시 돌려 이 파일을 갱신하면 된다.

---

## 6. 다음 작업

- [x] **YouTube 업로드 완료 (2026-08-16)** — **https://youtu.be/g3pzx97skDU**
      제목 "COPC 포인트클라우드를 변환 없이 CesiumJS에 스트리밍 — copc-cesium" · 채널 goldenlabs
      외부 접근 확인: oEmbed HTTP 200 (비공개면 401/404). 설명·챕터 문안은 `docs/submission/video/youtube-description.md`
      남은 확인: 1080p 처리 완료 여부, 시크릿 창 재생
- [ ] **결과보고서 작성** — 5페이지 이내, 함초롬바탕 10pt, HWP/DOCX **+ PDF 변환본** 2부
- [ ] **별첨1 SBOM 작성** — 라이브러리·버전·라이선스·URL·사용 목적 표 (필수)
- [ ] **별첨2 AI 활용 고지** — 상용 AI 단순 활용은 체크리스트 제외지만 **4번(소스코드 라이선스·개발환경) 은 전원 필수**
- [ ] 제출: osscontest.kr 온라인, **2026-08-27(목) 18:00** 마감

### 대회 요강에서 확인한 사실 (결과보고서 양식 원문)
- 파일명 규칙: `2026 오픈소스 개발자대회 결과보고서_접수번호(팀명)`
- 시연영상: "유튜브 업로드 후 URL 기재(별도 영상 파일 불가)"
- 제출 서류 2부 필수: HWP(HWPX) 또는 DOC(DOCX) 1부 + PDF 변환본 1부

### 영상에 쓸 수 있는 검증된 수치
- 오프라인 체크 **9/9**, 실데이터 통합 체크 **9/9** (2026-08-16 재확인)
- 렌더 **59–60 FPS** (RTX 4090, Autzen)
- Autzen 로드 ~5.9초, 노드 60개, **실패 0**
- 대형 데이터: SoFi Stadium **1.9GB** 사전 변환 없이 직접
- ECEF 좌표 오차 최대 **1.4 × 10⁻⁹ m**
- S3 range 왕복 **61 → 6** (이슈 #02) · 재투영 **582 → 10.7 ms/1M점, 54×** (이슈 #17)
- 깊은 줌 **16 → 89 fps** (이슈 #08) · Cahokia **8.9GB** 90초 soak 메모리 plateau (PROGRESS)

> **쓰지 말 것**: `docs/bench/fair-compare-*.md` 의 Eptium 비교. 문서 자체가 "유효성 게이트 FAIL →
> verdict 신뢰불가" 로 못박혀 있다. `settle 13.9s→4.8s` 도 ADR-006 에 Eptium TTD 비교가 같은 표에
> 인접해 있어 인용을 피했다.

> 수치를 인용할 때는 반드시 이 세션 또는 `docs/RESULTS.md`·`docs/bench/` 의 실측과 대조할 것.
> 이전 영상에서 npm 패키지명 오안내 사고가 있었다 — 현재 정식 이름은 `@goldenlabs/copc-cesium`.

---

## 7. 이웃 세션 교차검토 (Orca orchestration)

같은 worktree 의 "경쟁 프로젝트 COPC 타일셋 분석" 세션에 3라운드 검토를 받았다.
경로: `orca orchestration run-create` → `task-create --spec` → `dispatch --inject` → `check --wait`.

| 라운드 | 지적 | 처리 |
|---|---|---|
| 1차 | s8 HUD 모순 · s3 과장 · URL 부재 · 측정 누락 · 점조회 누락 | 5건 전부 반영 |
| 2차 | s3 **카드**에 옛 문구 잔존 · s4b 앞 6초 공백 | 2건 전부 반영 (#32 발견) |
| 3차 | — | **신규 결함 0 · 제출 가능** |

리뷰어 결론: *"1차에서 영상이 담은 차별점은 '표준 타입 반환' 하나였고 경쟁작(README 첫 줄
'no pre-tiling, no backend')과 변별이 사실상 없었다. 지금은 원본 점 접근(s4b)과 측정 기반
최적화(s9b)가 더해져 두 출품작을 나란히 놓아도 갈라지는 지점이 생겼다."*

**교훈**: 대본만 읽는 검토는 놓친다. 리뷰어가 **프레임을 실제로 추출해 화면과 나레이션을 1:1 대조**했기에
HUD 모순과 카드 잔존 문구가 잡혔다. 다음 영상 검토도 같은 방식으로 할 것.

### 경쟁작 메모
`github.com/gyeonghokim/copc-tileset` — 2026-07-12 생성, AGPL-3.0, npm 미배포, stars 0.
아키텍처가 거의 동일(SW 로 3D Tiles 동적 합성). **같은 대회 출품작으로 판단**(감독님 정리).
따라서 "오픈+Cesium 해결책 부재" 프레이밍은 쓰지 않는다. 결과보고서에서는 위협이 아니라
**설계 타당성의 독립 검증** 근거로 쓸 수 있다.
