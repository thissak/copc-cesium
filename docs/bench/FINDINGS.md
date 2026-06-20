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

---

## 2026-06-20 재검증 — 공정 비교 도구(fair-compare)로 §v4 주장 재평가

§v4의 "부드러움 동급·메모리 2× 우위"가 **motion 중 측정**(LOD 못 따라잡은 under-refined 장면)과 **단일 작동점(712k 매칭)**의 산물일 수 있다는 의심에서, 엄밀한 공정 비교 도구를 새로 만들었다(`scripts/bench/fair-compare.ts`, [[설계]] `docs/superpowers/specs/2026-06-20-fair-engine-bench-design.md`). 도구 특성: 양쪽 동일 config 정규화 · 고정 시점 · **GPU 타이머 쿼리 GPU ms**(vsync 무관) · 로딩 곡선 샘플링 · **ours-vs-ours 영실험 자기검증** · 유효성 게이트 통과 시에만 verdict.

### 결과: 도구가 verdict를 **거부**했다 (가짜 숫자 0)
sofi E2E: `nullOk=false (floor=62.9%) · overlap=2 · 2/4 게이트 FAIL → 신뢰불가`. 자기검증이 정확히 작동 — 못 믿을 비교를 단정하지 않고 *왜 못 믿는지*를 정량으로 드러냈다.

### 진단 (실 GPU 인라인, 2건)
1. **노이즈(62.9%)**: 업로드 프레임 제외해도 불변(원인 아님). 진짜 원인 = **gpuMs가 점수에 가파른 비선형**(1.75M=11.6ms → 2.25M=53.6ms; 점 1.3배에 GPU 4.6배). 250k 버킷이 이 구간엔 coarse → 런 간 버킷 내 점수차가 큰 gpuMs차로 증폭.
2. **overlap(2버킷)**: 시점 동일(양쪽 bs center ECEF ~일치)·msse override 먹음 → 버그 아님. 진짜 원인 = **엔진 근본 차이** — 같은 SSE(msse=2)·같은 시점에서 **ours 17M점 ↔ Eptium ~1M점(작은 뷰포트 464k)**. 점 범위 [1.5–17M] vs [0.4–1M]라 거의 안 겹침.

### 핵심 발견 — LOD 전략이 근본적으로 다르다 (point budget vs 무제한 SSE)
후속 msse 스윕(같은 깊은 시점, 2026-06-20)으로 정확한 원인을 못박았다 — "ours가 과-refine"이 아니라 **전략 차이**다:

| msse | ours pts | **Eptium pts** |
|------|----------|----------------|
| 32 | 1.81M | **763,741** |
| 16 | 5.13M | **763,741** |
| 8 | 10.18M | **763,741** |

**Eptium은 msse 무관하게 764k 고정 → 고정 점 예산(point budget)**(Potree 방식). **ours는 표준 Cesium SSE refine이라 점 상한이 없다** → 깊게 가면 무한정(10M+). "17~37×"는 *공격적 refine*이 아니라 **ours에 점 예산이 없어서** 생긴 격차.

→ **§v4의 "동급/2×"는 712k 매칭 작동점 한정**(ours를 높은 msse로 throttle). 깊은 줌 실사용에선 ours가 무제한 점 → GPU-bound(~58fps), Eptium은 764k 캡 → ~120fps. **단일 공정 verdict 불가**(겹친 2버킷서 ours per-point ~0.5× gpuMs였으나 62.9% 노이즈로 확정 불가). → **약점 = point budget 부재**, 업그레이드 백로그 = **이슈 #08**(`docs/issues/08-point-budget.md`).

### 대회용 주장 가이드 (정직)
- ❌ "Eptium 대비 부드러움 동급" / "메모리 2× 우위"를 **무조건 헤드라인으로 쓰지 말 것** — 매칭 작동점 한정 + motion 측정 아티팩트.
- ✅ 방어 가능: "변환 없이 CesiumJS 직접 렌더" · "양자화로 점당 메모리 절반" · "재현 가능한 측정 하네스" · "공정 비교 도구가 자기검증으로 신뢰불가를 표면화(정직성)".
- 업그레이드 1순위(이슈 #08): **point budget 추가** — ours에 점 예산이 없어 깊은 줌서 무제한 점→GPU-bound. ~1~3M 캡으로 최악 비용 유계화(BP 조사→설계→검증 필요, STOP 규칙). fair-compare 도구 노이즈(가파른 곡선·버킷)·overlap(점예산 격차)은 큰 재설계 필요라 보류.

---

## 2026-06-20 재재검증 — point budget(이슈 #08) 적용 후 fair-compare 재실행

이슈 #08(pointBudget 기본 200만, PR #9 머지) 출하 후 **코드 변경 0으로 같은 도구 재실행**(`npm run bench:fair -- --ds sofi`). ours가 이제 2M로 캡되니 위 §2026-06-20이 거부 이유로 든 두 장벽(노이즈·overlap)이 바뀌는지 검증. 산출물 `docs/bench/fair-compare-sofi.{md,json}`(재생성).

### 결과: 게이트 `nullOk=true(floor 8.4%) · overlap=2 · 여전히 verdict 거부`

| 축 | 이전(무제한) | point budget 후 | 판정 |
|----|-------------|----------------|------|
| **노이즈 바닥**(ours-vs-ours) | 62.9% ❌ | **8.4% ✅** | **해소 — 영실험 처음 통과** |
| overlap 버킷 | 2 ❌ | 2 ❌ | 미해소(Eptium plateau 437k, 뷰포트 의존) |
| ours finalPts | 10M+ | **1.91M** | 캡 작동 확인 |

### 핵심 발견 (정직)
1. **point budget이 노이즈 장벽을 제거(62.9%→8.4%)** → 도구 자기검증(영실험 ours-vs-ours=동급) **처음 통과**. 캡이 ours GPU 곡선을 평탄화한 직접 결과 — *공정 비교의 노이즈 축은 point budget으로 풀렸다.*
2. **ours 깊은 줌이 부드럽게 plateau**: 2M 버킷 @ **7.25ms (n=5156, 정착)** — 무제한 시절 10M/120ms GPU-bound가 해소됨을 대칭 도구로 재확인. (1.25~1.5M의 53/65ms는 로딩 transient, n=43/14로 미미.)
3. **단 overlap 2/3 부족 → 도구는 여전히 단일 verdict 정직 거부.** 이번 Eptium plateau 437k(뷰포트 의존, §2026-06-20 회차는 764k)라 250k·500k 2버킷만 겹침.

### 겹친 버킷 (시사적 — headline 불가)
| 버킷 | ours gpuMs | eptium gpuMs | ratio |
|------|-----------|--------------|-------|
| 250k | 5.94 | 11.23 | 0.53 |
| 500k | 6.11 | 11.41 | 0.54 |

ours per-point ~2× 빠르나 — **2버킷뿐 + 로딩 transient 구간(ours n=415/157, eptium n=11/60)**이라 정상상태 비교 아님. ❌ "Eptium 대비 2× 빠름" 헤드라인 금지(overlap 게이트 FAIL을 도구가 명시).

### 주장 가이드 갱신 (이번 회차로 추가 방어 가능)
- ✅ **추가 방어 가능**: "point budget 도입으로 깊은 줌 GPU-bound 해소 — 대칭 측정서 ours가 2M에서 ~7ms로 정착(무제한 120ms→캡 7ms)" · "공정 비교 도구의 노이즈 장벽(62.9%→8.4%)이 캡으로 제거돼 자기검증 처음 통과".
- ⚠️ 여전히: 단일 공정 verdict는 overlap 부족(엔진 plateau 격차 + 뷰포트 의존)으로 불가. 매칭 작동점(ours를 Eptium 예산에 맞춤) head-to-head는 별도 — transient·overlap 우회하나 "매칭 한정" caveat 동일.

---

## 2026-06-20 매칭 예산 head-to-head — fair-compare 한계(overlap·transient) 우회

fair-compare가 overlap 부족·transient로 못 푼 비교를, **ours cacheBytes를 Eptium 점 수에 맞춰** 고정 깊은 시점·같은 config(globe/EDL/atten off·res=1)·**정상상태 plateau(최다프레임 버킷)** gpuMs로 직접 비교(`scripts/bench/probe-matched.ts`, `npm run bench:matched`). 산출물 `docs/bench/budget/matched-sofi.{md,json}`.

| 엔진 | plateau 점수 | gpuMs | n(프레임) | GPU fps 천장 |
|------|-------------|-------|-----------|-------------|
| **ours** (cacheBytes 4MB) | 500k | **5.72** | 899 | 175 |
| **eptium** (자체 예산) | 600k | **14.16** | 58 | 71 |

ours 스윕 전 구간 평탄: 500k/5.72 · 800k/5.24 · 1M/5.71 · 1.3M/5.97 ms.

### 발견 (정상상태, fair-compare보다 견고)
- **ours per-frame GPU ~0.4× (≈2.5배 빠름)** — 매칭 점 오차 16.7%(브래킷이 600k 건너뜀)지만 **ours gpuMs가 500k~1.3M 평탄(~5.5ms)**이라 결론 견고. 정상상태 n=899~3074(fair-compare transient n=11~415보다 훨씬 안정).
- **overlap·transient 둘 다 우회**: 둘 다 ~500-600k(겹침) + plateau(정상상태).
- GPU 타이머 관점: Eptium도 깊은 줌 GPU 작업 ~14ms — 이전 "120fps"는 vsync 벽시계, 실제 GPU는 11~14ms.

### ⚠️ caveat (headline 금지 — competition-goal-north-star 준수)
1. **EDL/atten OFF** — **raw 점 래스터화** 비용만. ours 양자화 pnts(uint16 위치=바이트 절반)가 GPU 대역폭 우위의 유력 원인. 실사용(EDL on)선 다를 수 있음(→ 아래 §EDL-on 으로 검증).
2. **매칭 작동점 한정**(~500-600k) + 단일 데이터셋(sofi) + Eptium plateau 뷰포트 의존.
- ✅ 방어 가능 톤: "매칭 디테일·EDL-off raw-point·정상상태에서 ours GPU 비용이 Eptium의 ~0.4배 — 양자화 경량 파이프라인의 측정 가능한 이득(매칭점 한정, 헤드라인 아님)."

### §EDL-on — 실사용 셰이딩 켜고 매칭(위 caveat 1 검증, `npm run bench:matched -- --edl`)
직전 매칭의 "EDL-off라 양자화 아티팩트일 뿐" caveat을 검증 — EDL/atten ON(실사용 시각)으로 양 엔진 동일 측정(`fair-probe.normalizeSurfaceEdlOn`). 산출물 `docs/bench/budget/matched-sofi-edl.{md,json}`.

| 엔진 | plateau 점수 | gpuMs | GPU fps 천장 |
|------|-------------|-------|-------------|
| **ours** (cacheBytes 4MB) | 500k | **5.19** | 193 |
| eptium (자체 예산) | 400k | **9.08** | 110 |

- **EDL 비용이 ours에 ~1ms 이하만 더함**(500k: off 5.72→on 5.19 · 1.3M: 5.97→7.05). GPU 타이머가 EDL 패스(preRender~postRender) 포함하므로 누락 아님 — EDL이 M4서 싸다. → **직전 우위가 EDL-off 아티팩트가 아님 확인**: 실사용 시각에서도 ours 빠름(5.19↔9.08, ours ~1.75×, ours가 점도 더 많음).
- **caveat 심화**: ratio가 0.40(off)→0.57(on)로 우위 축소했으나 **EDL 탓 아님** — 이번 Eptium plateau가 400k(직전 600k)로 떨어진 탓(뷰포트 의존). 매칭 오차 25%(ours 500k vs Eptium 400k)·**Eptium plateau run 변동(400~764k)이 이 비교의 최대 약점**.
- ✅ 방어 톤: "우위 방향(ours GPU 비용 낮음)은 EDL off/on 양쪽서 견고, 크기는 1.75~2.5× 범위로 불확실(Eptium plateau 변동). 실사용 EDL-on서도 ours 우위 유지 — raw-point 아티팩트 아님." 매칭점·단일 ds 한정, 헤드라인 아님.

---

## 2026-06-20 다중 ds 일반화 시도 — measure-first가 "단순 우위 헤드라인"을 반증

"ours가 Eptium보다 빠르다"를 대회 주장으로 굳히기 전, sofi 단일·600k 한정을 **3개 ds·전 작동점**으로 일반화 시도(`probe-matched.ts --ds autzen,millsite,sofi`, EDL-off, `matched-general.md`). **결과: 클린하게 일반화되지 않았다 — 그리고 그게 핵심 발견이다.**

### 측정 (매칭점 gpuMs, 깊은 0.15r)
| ds | Eptium 작동점(plateau/finalPts) | ours @ 같은 점수 | ratio | 클린 매칭? |
|----|------|------|-------|-----------|
| autzen | 3.1M / 3.05M (정착) | ours 캡 ~1.3M | 0.171 | ❌ 오차 58% (ours가 적게 그림) |
| millsite | 400k / **5.5M** (미정착) | 400k 4.46ms ↔ Eptium 9.96ms | 0.448 | ⚠️ Eptium 작동점은 5.5M, 400k는 로딩 통과점 |
| sofi | 400k / 442k (정착) | 400k 4.33ms ↔ Eptium 9.98ms | 0.434 | ✅ 둘 다 정착·400k |

### 보정된 결론 (도구 자동 verdict "전 ds 우위 ✅"는 과장 — 정정)
1. **Eptium은 균일하게 캡하지 않는다 → 기존 "764k 고정 점예산"은 sofi-뷰 한정.** 깊은 0.15r서 Eptium 작동점이 데이터셋마다 극명히 갈림(autzen 3.1M·millsite 5.5M·sofi 442k). "Eptium=고정 점예산"(이슈 #08/이 문서 §2026-06-20 상단)은 sofi 특정 뷰의 산물이었다.
2. **"ours가 Eptium보다 빠르다"는 단순 헤드라인은 일반화 안 됨.** autzen/millsite 깊은 뷰서 Eptium은 3~5.5M(더 많은 디테일)을 그리고 ours 캡은 거기 안 감 → 같은 *디테일* 비교 불가. **클린 same-operating-point 우위는 sofi에서만** 성립(0.43×).
3. **단 robust한 것 = per-point GPU 효율.** 같은 점 수에서 ours gpuMs(4~5.5ms) < Eptium(~10ms), **전 3개 ds 일관**. ours 곡선 평탄(max/min 1.2~1.27×) → 우위가 한 점 아닌 전 점수 범위(단 millsite는 Eptium 로딩 중 버퍼업로드 confound 가능).

### 주장 가이드 (정정·강화)
- ❌ "오픈소스가 상용보다 빠름" 단순 헤드라인 금지 — 일반화 안 됨(measure-first가 반증).
- ✅ 방어 가능: **"같은 점 수(매칭 디테일)에서 ours가 GPU를 ~2× 덜 쓴다 — 양자화 경량 파이프라인(uint16 위치), 3개 ds 일관."** + **"ours는 point budget으로 깊은 줌 부드러움을 유계화(2M/~11ms/89fps), Eptium은 무제한 디테일(5.5M)을 택해 더 무거움 — 다른 트레이드오프."**
- 이게 measure-first의 가치: 과장(전 작동점 우위)을 대회 주장으로 굳히기 전에 측정으로 잡고, *진짜 방어 가능한* 더 정밀한 주장(per-point 효율 + 트레이드오프)으로 교체.
