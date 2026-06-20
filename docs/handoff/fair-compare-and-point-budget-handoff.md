# Handoff — 공정 비교 도구(fair-compare) + point budget 약점

> 작성 2026-06-20 · 브랜치 `feat/fair-engine-bench` (미머지) · 현재 상태 + 다음 작업 + 알려진 한계

## 한 줄 요약

"Eptium 대비 우리가 빠른지 공정 판정하는 측정 도구"를 만들었으나 — 그건 **단일 verdict로 환원 불가**(도구가 자기검증으로 정직하게 거부). 대신 그 과정이 **진짜 약점 = "우리 플러그인엔 point budget이 없다"**를 측정으로 발견(→ **이슈 #08**). 다음 사이클은 #08 업그레이드.

## 현재 상태 (DONE)

### 1. 공정 비교 도구 `scripts/bench/fair-compare.ts` (작동, 단 verdict 거부)
- `npm run bench:fair -- --ds sofi` — headed Chromium(실 GPU)로 우리+Eptium을 `window.viewer` 대칭 구동.
- 5대 통제: ①config 정규화(globe off·EDL/atten off·resolutionScale 고정, Eptium은 매프레임 reassert) ②고정 ECEF 깊은 시점 ③**cost=GPU 타이머 쿼리 GPU ms**(vsync 무관 — `--disable-gpu-vsync` macOS Metal 미작동 확인 후 피벗) ④로딩 곡선 샘플링(settle 비현실적이라 — 단조 로딩 60s+) ⑤ours-vs-ours 영실험 자기검증.
- 구성: `fair-probe.ts`(브라우저 주입, esbuild IIFE 번들 `fair-probe-bundle.js`) · `fair-types.ts` · `fair-report.ts` · `fair-compare.ts`(오케스트레이터).
- 설계: `docs/superpowers/specs/2026-06-20-fair-engine-bench-design.md` · 계획: `docs/superpowers/plans/2026-06-20-fair-engine-bench.md`.

### 2. E2E 결과: 도구가 verdict 거부 (정직성 — 가짜 숫자 0)
`nullOk=false(floor 62.9%) · overlap=2 · 2/4 게이트 FAIL → "신뢰불가"`. 산출물 `docs/bench/fair-compare-sofi.{md,json}`.

### 3. 진짜 발견 (measure-first): point budget 부재
msse 스윕(깊은 시점): ours 1.81M/5.13M/10.18M(msse 32/16/8) ↔ **Eptium 763,741 고정(msse 무관)**. Eptium=점 예산, ours=무제한 SSE refine. ours 깊은 줌 ~58fps(GPU-bound) ↔ Eptium ~120fps. → **이슈 #08** + `docs/bench/FINDINGS.md §2026-06-20`.

## 이슈 #08 — point budget ✅ 완료 (2026-06-20)

measure-first 게이트로 BP→설계→구현→검증 완료. **Cesium 네이티브 `cacheBytes`로 point budget 근사**(손코딩 0, ADR-001 위임 철학 유지): `pointBudget` 옵션(기본 200만) → `cacheBytes = maximumCacheOverflowBytes = pointBudget × 8B`(점당 실측 ~16B). 동적 SSE 외부루프는 measure로 불필요 판정(Circuit Breaker).

**검증(실 GPU M4 Pro, 2시점 × on/off, `scripts/bench/probe-budget.ts`):** 깊은 줌 9.29M/61ms(16fps) → **2.10M/11ms(89fps)**, 정상뷰 7.0M/82ms → 2.06M/34ms, **양 시점 스크린샷 시각 동일**(여분점 = sub-pixel noise). 환산 정확(2M→실측 2.10M ±5%). tsc·`verify`(autzen Oregon) 회귀 0. **measure-first가 전제 2개 적발(#05 교훈)**: ① sub-pixel 가정은 EDL on서도 참 ② "정상뷰 무영향"은 거짓(msse=2서 7M)이나 7M→2M 시각동일이라 품질 OK. 상세 `docs/issues/08-point-budget.md` §3(BP)·§4(게이트)·§5(검증) · `docs/bench/budget/sofi-verify.*`.

**다음**: 이 브랜치 PR/머지 · 결과보고서.

## Eptium 재테스트 (point budget 후, 2026-06-20 · PR #9·#10·#11 머지)

#08 출하 후 같은 도구로 Eptium 재비교:
- **fair-compare 재실행**: ours 2M 캡 → 영실험 노이즈 62.9%→8.4%(자기검증 처음 통과). 단 overlap 2/3로 단일 verdict 여전히 거부.
- **매칭 head-to-head**(`probe-matched.ts`, ours를 Eptium 점수에 맞춤·정상상태): EDL-off ours GPU ~0.4×(5.72↔14.16ms). EDL-on(`--edl`) ours ~1.75×(5.19↔9.08ms) — **EDL이 ours에 ~1ms만 더해 우위가 raw-point 아티팩트 아님 확인**.
- ⚠️ **headline 금지**: 매칭점·단일 ds·Eptium plateau run 변동(400~764k) → 방향 견고, 크기 1.75~2.5× 불확실. `docs/bench/FINDINGS.md` §재재검증·§매칭·§EDL-on.
- **미커밋(EDL-on 작업)**: `scripts/bench/{fair-probe,probe-matched}.ts`(EDL 지원) + `matched-sofi-edl.*` — 작업 브랜치 커밋 필요.

## 알려진 한계 / 보류

- **fair-compare 도구는 단일 verdict 산출 불가**(설계 한계, 보류): ①노이즈(gpuMs가 점수에 가파른 비선형 → 250k 버킷 coarse → ours-vs-ours 62.9%) ②overlap(엔진 점예산 격차로 곡선 거의 안 겹침). 살리려면 큰 재설계(버킷 초세분+장시간 샘플, 점 범위 정합) 필요 — ROI 불확실, 보류.
- 단 **`measureLoadCurve`(우리 GPU ms-vs-점수 곡선) 자체는 self-프로파일러로 유효** — #08 검증에 재사용.
- 브랜치 `feat/fair-engine-bench` 미머지. 머지 가치: 도구(self-프로파일러) + FINDINGS 발견 + 이슈 #08. 머지 전 정리(SDD 잔여 Minor: disjoint deleteQuery 1줄, NORM dead canvasW/H 등 — `.superpowers/sdd/progress.md` 참조).

## 핵심 파일
- 도구: `scripts/bench/fair-{compare,probe,types,report}.ts` · `fair-probe-bundle.js`
- 발견: `docs/bench/FINDINGS.md` §2026-06-20 · `docs/bench/fair-compare-sofi.{md,json}`
- 이슈: `docs/issues/08-point-budget.md` (GH #8)
- 설계/계획: `docs/superpowers/{specs,plans}/2026-06-20-fair-engine-bench*`
