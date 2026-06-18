# Eptium 벤치 — 정직한 결론 (autzen, 2026-06-18)

> 이 문서가 `eptium-autzen.md`(자동 생성 리포트)보다 우선한다.
> 자동 리포트의 Tier 1a 숫자(TTD −63%, bytes −98% 등)는 **무효**다. 아래 이유로 직접 비교가 성립하지 않는다.

## TL;DR

- **★ 매칭 점수 공정 비교(millsite, 실 GPU) — 북극성 베이스라인** [아래 §v4]: 같은 렌더 디테일(~712–757k 점, Δ+6%)에서 **부드러움은 동률**(양쪽 120fps vsync·hitch 0 — "부드럽게" 목표 달성), **메모리는 우리가 ~2× 우위**(73.6 vs 144MB), **로드는 Eptium이 ~4× 빠름**(3.8–4.1s vs 13.9–16.2s, 우리 deep-load IO 갭=이슈 #02). #01·#03 수정 후 처음으로 **점 개수를 맞춘 공정 비교**가 성립.
- **유효한 결론 1개**: autzen 규모에선 **우리 플러그인과 Eptium 둘 다 똑같이 부드럽다.** 실 GPU(Apple M4 Pro Metal)에서 양쪽 frametime p50 = 8.3ms(120Hz vsync 천장), hitch>50ms = 0, longTask = 0. 즉 이 데이터셋은 둘 중 누구에게도 부담이 아니다 → "부드러움" 차이를 보려면 **더 큰 데이터셋(millsite·sofi)** 이 필요하다.
- **나머지 축(로드·네트워크·메모리·품질)은 현재 방식으론 공정 비교 불가.** 측정값은 "서로 다른 양을 로드한 두 상태"를 비교한 것이라 의미 없다.

## 왜 1a 비교가 무효인가 (측정으로 확인)

| 증인 | ours | eptium | 문제 |
|------|------|--------|------|
| bsRadius | 1004.2 | 881.7 | **같은 autzen인데 바운딩스피어가 다름** → `flyToBoundingSphere` framing 거리·SSE가 달라짐 |
| msse | 8 | 32 | msse=32에선 우리 타일셋이 full-cloud 거리에서 타일을 거의 요청 안 함(degenerate) → 부득이 ours=8 |
| tilesReady | **1** / 278 | **11** / 280 | ours는 루트 1타일에서 "settle", eptium은 11타일 → **로드량 자체가 다름** |
| pointsSelected | 61,201 | 381,256 | 84% 차 — 품질이 동등하지 않음 |
| pointsLength | 0 | 0 | 양쪽 0 → 무의미한 신호(증인으로 부적합) |
| bytesTotal | 76KB | 4.3MB | ours는 노드 content를 **Web Worker→SW** 경유로 받아 페이지 CDP에 안 잡힘 → ours는 헤더(main-thread)만 집계 |
| reqCount | 3 | 24 | 위와 동일(SW 블라인드) |

→ TTD·bytes·heap의 "ours가 빠름/적음"은 **덜·다르게 로드한 결과**일 뿐, 성능 우위가 아니다.

## 유효 데이터 (실 GPU, 동일 머신)

| 지표 | ours | eptium | 판정 |
|------|------|--------|------|
| frametime p50 / p95 | 8.3 / 9.7 ms | 8.3 / 9.4 ms | 동률(vsync 천장) |
| hitch >50ms | 0 | 0 | 동률 |
| longTask 합 | 0 ms | 0 ms | 동률 |
| GL renderer | M4 Pro Metal | M4 Pro Metal | 실 GPU 확인 |

## 인프라 상태 (재사용 가능)

`scripts/compare-eptium.ts` + `scripts/bench/{probe,report}.ts` 하니스는 완성·동작한다(`npm run bench:eptium`). 양쪽을 `window.viewer`로 대칭 구동하고 CDP·프로브로 수집한다. **인프라는 멀쩡하고, 측정 방법론만 보강하면 된다.**

## v2 — 공정 비교를 위해 필요한 것

1. **품질 정규화 = 매칭 렌더 점수**(매칭 msse 아님). 각 뷰어의 msse를 조절해 `numberOfPointsSelected`를 ±10% 안으로 맞춘 뒤 비교.
2. **카메라 framing 통일**: 동일 바운딩(우리 vs Eptium bsRadius 차이 원인 규명) 또는 동일 ECEF 뷰포인트를 양쪽에 강제.
3. **우리 SW 네트워크 캡처**: CDP `Target.setAutoAttach`로 Service Worker 타깃에 Network 부착하거나, 우리 앱 내부 계측으로 바이트 집계(화이트박스). 안 되면 네트워크 축은 "비교 제외"로 명시.
4. **더 큰 데이터셋**: autzen은 둘 다 vsync 천장이라 부드러움이 구분 안 됨 → millsite(1.35GB)·sofi(1.9GB)로 frametime/hitch가 갈리는 지점에서 측정.

## v2 (millsite 1.35GB, 실 GPU M4 Pro) — 핵심 발견: **우리 플러그인이 under-refine 한다**

같은 octree(타일 3588 vs 3590), 비슷한 framing(bsRadius 4818 vs 4692), **동일 msse=8**:

| 지표 | ours | eptium | |
|------|------|--------|--|
| pointsSelected | **40,535** | **1,486,522** | **37× 차** |
| tilesReady | **1** (루트만) | **109** | |
| ttdMs | 527 | 6162 | ours는 1타일이라 빨리 "끝남" |
| frametime p95 / hitch | 9.2ms / 0 | 9.5ms / 0 | 둘 다 vsync 천장, 동률 |
| peakHeap | 56MB | 167MB | ours가 적은 건 적게 그려서 |
| bytes / req | 182KB / 3 | 16.7MB / 116 | ours는 SW 블라인드(무효) |

**ours refine 곡선 (millsite, #01 수정 前):** msse8 → 40,535점 · msse4 → 85,189점 · msse1 → 712,458점(당시 "ttd 25s·settle 못함"으로 기록 — 실은 **settle 메트릭 결함**이었고 실제 settle은 ~16s. 원인=`numberOfTilesProcessing` 13 영구 고착, 이슈 #03).
**eptium:** msse8 → 1,486,522점.

### 결론 (북극성)

1. **부드러움(frametime)은 M4 Pro에서 구분 안 됨** — 양쪽 120fps vsync 천장·hitch 0. 단 이건 우리가 *디테일을 훨씬 적게 그려서*이기도 하다. 즉 "부드럽다"가 우위가 아니다.
2. **진짜 격차 = refinement(디테일 선택)**: 동일 msse·동일 octree·동일 framing에서 우리는 **루트 1타일(40k점)**, Eptium은 **109타일(1.49M점)**. 우리 `CopcTileset`의 geometricError→SSE 매핑이 Cesium 표준보다 **1~2 자릿수 더 보수적**이라, 같은 msse에서 거의 refine하지 않는다.
3. **깊게 밀면 느리고 불안정**: Eptium 수준 디테일(≈1.5M)을 보려면 우리는 msse≈1이 필요한데, 그때 712k 로드가 느리고(실제 settle ~16s — 초기 "25s 미settle" 기록은 settle 메트릭 결함이었음, 이슈 #03) 첫 시도는 flaky 실패(재시도 성공).

→ **"변환없이·빠르고·부드럽게" 이전에, 우리는 애초에 디테일을 충분히 안 그리고 있다.** 객관 오라클이 잡아낸 1순위 결함이다.

### v3 권고 (실행 시)

1. ~~**`CopcTileset`의 노드별 geometricError 보정**~~ ✅ **해결됨 (이슈 #01)** — `src/tileset.ts` base를 `spacing`(=cube/147) → `cube_size/16`(ept-tools 관례)로. millsite msse=8: tilesReady 1→79, 점수 40k→728k(격차 37×→~2×), autzen 61k→1.46M. 상세 `docs/issues/01-copc-under-refine-geometricerror.md`.
2. **deep-load 성능·안정성** — 일부 진척: 워커 풀은 측정상 무효로 기각(이슈 #02, 병목=네트워크 IO), 벤치 "25s 미settle"은 메트릭 결함으로 판명·수정(실제 ~16s, 이슈 #03이 근본원인 추적). 잔여: Eptium 대비 ~2.3× 느린 per-tile IO 프로파일 + flaky 첫 시도(이슈 #02 §5).
3. **매칭 점수 재벤치** — 각 뷰어 msse를 조절해 pointsSelected를 ±10%로 맞춘 뒤에야 load-time·smoothness가 공정 비교됨.

## v4 — 매칭 점수 공정 비교 (millsite, 실 GPU M4 Pro, 2026-06-18)

#01(under-refine)·task#1(settle 메트릭)·#03(빈 노드 고착)을 다 고친 뒤, **렌더 점 개수를 ±10%로 맞춘**
operating point에서 비교. 매칭점은 scout(`scripts/bench/match-sweep.ts`)으로 도출 — 두 뷰어의 refine 곡선이
같은 msse에선 안 겹치므로(coarse 영역 Eptium ~2×) per-target msse로 점수를 맞췄다: **ours msse=8 ↔ eptium msse=14**.
실행: `npm run bench:eptium -- --ds millsite --msse-ours 8 --msse-eptium 14 --settle 30000`.

| 지표 | ours (msse=8) | eptium (msse=14) | 판정 |
|------|--------------|------------------|------|
| pointsSelected | 712,458 | 757,536 | **매칭 Δ+6.3%** (공정 성립) |
| tilesReady | 57 | 53 | 비슷 |
| frametime p50 / p95 | 8.3 / 9.2–9.3 ms | 8.3 / 10.0 ms | **동률** (양쪽 120fps vsync 천장) |
| hitch >50ms | 0 | 0 | **동률** |
| **TTD (settle)** | **13.9–16.2 s** | **3.8–4.1 s** | **Eptium ~4× 빠름** |
| **peakHeap (메인스레드)** | **73.6 MB** | **144 MB** | **ours ~2× 적음** |
| bsRadius (framing) | 4818 | 4692 | 근접(±3%) |
| GL renderer | M4 Pro Metal | M4 Pro Metal | 실 GPU |

(TTD·heap는 2회 측정 범위. bytes 축은 여전히 무효 — 우리 콘텐츠는 SW/Worker 경유라 페이지 CDP에 안 잡힘.)

### 결론 (북극성 베이스라인)

같은 디테일을 그릴 때:
1. **부드러움 = 동률.** 양쪽 p50 8.3ms(120fps vsync)·hitch 0. 주최사 목표어 **"부드럽게"를 상용 레퍼런스와 동급으로 달성** — 이제 *적게 그려서 부드러운 게 아니라*(v2 한계 해소) 같은 점수에서 동률.
2. **메모리 = 우리 우위(~2×).** 매칭 디테일에서 73.6 vs 144MB. v2의 "적게 그려서 적다"가 아니라 **양자화 pnts(uint16×3 위치, 바이트 절반) + 경량 파이프라인의 실질 이득**. (caveat: 메인스레드 heap만 — 양쪽 워커 디코드 heap은 미집계.)
3. **로드 속도 = Eptium 우위(~4×).** 3.8 vs 16s. 우리 약점은 **deep-load IO**(SW→page→worker→S3→디코드→역경로 per-tile 오버헤드, HTTP/1.1 ~6 동시연결) — 이슈 #02의 진단과 일치. **다음 개선 1순위.**

→ "변환없이·부드럽게"는 동급 입증, "빠르게"(로드)가 유일한 실측 격차. 메모리는 오히려 우리가 낫다.

## 히스토리 주의

이 브랜치엔 자동 Stop-훅 리뷰 게이트(`rev-t1` 팀메이트)가 감독 없이 만든 fix 커밋(`f96834a`·`561c863`)과 중복 메시지 커밋이 섞여 있다. 머지 전 squash 정리 권장. (rev-t1은 stand-down 처리됨.)
