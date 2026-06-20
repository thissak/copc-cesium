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

## 다음 작업 (이슈 #08 — point budget 업그레이드)

순서(STOP 규칙: LOD/스트리밍 → 코드 전 BP+계획+승인):
1. **§3 BP 조사** — Cesium3DTileset 네이티브 점예산 노브 유무 / Potree `pointBudget` 구현 / loaders.gl·giro3d prior art / 위임 철학(ADR-001/004)에 맞는 접근(동적 msse 조절 vs 노드 선택 캡).
2. **설계 spec**(`docs/superpowers/specs/`) + 검증기준 → 승인.
3. **구현** — pointsSelected를 목표 예산(~1~3M, `CopcTileset.fromUrl` 옵션 `pointBudget`)으로 캡.
4. **검증** — 품질 회귀 0(캡 전/후 시각 동일) · 깊은 줌 fps 58→≥100 · 유계성(임의 깊이 ≤ 예산) · verify/골든파일 불변. 측정 도구 = `measureLoadCurve`/`?perf` 실 GPU.

**전제 검증 필수**(#05 교훈 — 전제 거짓 가능): "점 캡이 *실제로* 부드러움을 사고 시각 품질을 안 깎는가"를 measure-first로 먼저 확인. 반례 주의: 넓고 성긴 데이터면 캡이 디테일을 깎을 수 있음.

## 알려진 한계 / 보류

- **fair-compare 도구는 단일 verdict 산출 불가**(설계 한계, 보류): ①노이즈(gpuMs가 점수에 가파른 비선형 → 250k 버킷 coarse → ours-vs-ours 62.9%) ②overlap(엔진 점예산 격차로 곡선 거의 안 겹침). 살리려면 큰 재설계(버킷 초세분+장시간 샘플, 점 범위 정합) 필요 — ROI 불확실, 보류.
- 단 **`measureLoadCurve`(우리 GPU ms-vs-점수 곡선) 자체는 self-프로파일러로 유효** — #08 검증에 재사용.
- 브랜치 `feat/fair-engine-bench` 미머지. 머지 가치: 도구(self-프로파일러) + FINDINGS 발견 + 이슈 #08. 머지 전 정리(SDD 잔여 Minor: disjoint deleteQuery 1줄, NORM dead canvasW/H 등 — `.superpowers/sdd/progress.md` 참조).

## 핵심 파일
- 도구: `scripts/bench/fair-{compare,probe,types,report}.ts` · `fair-probe-bundle.js`
- 발견: `docs/bench/FINDINGS.md` §2026-06-20 · `docs/bench/fair-compare-sofi.{md,json}`
- 이슈: `docs/issues/08-point-budget.md` (GH #8)
- 설계/계획: `docs/superpowers/{specs,plans}/2026-06-20-fair-engine-bench*`
