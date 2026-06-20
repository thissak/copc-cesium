# 설계: 공정 엔진 비교 벤치 (fair-compare)

<!-- created: 2026-06-20 · supersedes 측정 방법론 of 2026-06-18-eptium-bench-oracle-design.md -->

## 목표 한 줄

우리 `CopcTileset` vs **Eptium**(Hobu)을 **정착·점매칭·동일config·다중trial**로 측정해, "우리가 Eptium 대비 **빠른가/동급인가/느린가**"를 **신뢰구간과 함께 공정하게 판정**할 수 있는 측정 도구를 만든다. 빠른 숫자가 아니라 **판정의 신뢰성**이 산출물이다.

## 왜 새로 만드나 (현 벤치/주장이 무효인 근거)

기존 "부드러움 동급"·"메모리 2× 우위"(FINDINGS §v4)와, 2026-06-20 인라인 조사의 "Eptium이 1.4~2.7× 빠르다"는 **둘 다 신뢰할 수 없다.** 원인 = 측정 교란 5종:

| # | 교란 | 현 벤치(`compare-eptium.ts`)의 문제 |
|---|---|---|
| 1 | **motion 중 측정** | frametime을 `runStress`(zoomIn/rotate/zoomOut 반복) 중 수집 → LOD 못 따라잡은 under-refined 장면을 잼 → fps 부풀려짐(양쪽) |
| 2 | **msse 매칭** | msse는 엔진 간 비교 불가(우리 #01 geometricError 매핑이 다름). 같은 msse라도 점 수가 다름 |
| 3 | **정착 미완** | settle이 cap(22~25s)에 안 끝나 mid-load 측정 + 런 누적 오염(같은 msse=8인데 pointsSelected 3.48M→4.16M 드리프트) |
| 4 | **config 미통제** | 우리 EDL on, Eptium config 미상 → 엔진 차이인지 EDL 비용인지 분리 불가 |
| 5 | **단일 trial** | 분산 미측정 → 재현성·노이즈 바닥 모름 |

→ **정직한 현재 상태 = "모른다".** 이 도구가 생기기 전엔 우열을 단정하지 않는다.

## 확정된 결정 (감독 승인 2026-06-20)

| 항목 | 결정 | 비고 |
|------|------|------|
| 1차 목적 | **공정 판정 도구** 그 자체. 최적화 타깃 발굴은 *도구가 실격차 확인 후* 하위·조건부 | 감독 확정 ("우리가 느린지조차 판단 못 함 — 정확한 도구가 없어서") |
| "공정" 정의 | **양쪽 동일 config 정규화 = 엔진 순수비교** | 감독 확정 |
| 아키텍처 | **B안: 신규 `scripts/bench/fair-compare.ts`** — 기존 bench/ 스캐폴딩(데이터셋·probe 주입·browser/CDP) 재사용 + 클린 측정 코어 | 감독 확정. 기존 `bench:eptium`은 "motion 중 인터랙션 부드러움" 별개 측정으로 존치 |
| 환경 | Playwright headed = 실 GPU(Apple M4 Pro Metal, PoC 확인) | swiftshader fps 무효 회피 |

## 측정 단위

`measure(viewer, pointTarget, trial)` → **정규화·정착·점매칭된 한 표본**. 이 단위에 5대 통제가 모두 적용된다.

## 5대 통제 (공정성 보장)

### ① config 정규화 (양쪽 동일 렌더 조건)
양쪽 `window.viewer`에 동일 적용:
- `scene.globe.show=false` + `imageryLayers.removeAll()` (지형·imagery 비용 제거)
- **resolutionScale 고정** + `useBrowserRecommendedResolution=false` (DPR/fill-rate 통제) · **canvas 동일 픽셀**(예 1600×900, `page.setViewportSize`)
- `tileset.pointCloudShading` 동일: `eyeDomeLighting=false` · `attenuation=false` · 점크기 고정
- 배경색 동일
- 적용 후 **read-back으로 적용 확인**(아래 문제2 가드)

### ② 점매칭 (동일 pointsSelected)
- msse는 매칭 기준 아님. **`numberOfPointsSelected`로 매칭.**
- viewer별 msse 사다리 스윕 → (msse→pointsSelected, cost) 기록 → 공통 **점 타깃**[0.5M·1M·2M·4M, 데이터셋 상한 내]에서 보간.
- 헤드라인 1~2 점타깃은 msse **이진탐색으로 ±5% 정밀매칭**.

### ③ 완전정착 (드리프트 차단)
- 정착 = `numberOfPendingRequests===0 ∧ tilesReady 안정 ∧ pointsSelected 안정` 이 **2.5s 연속** 유지.
- cap = 60s. **cap 도달 = 정착 실패로 간주, 그 점은 측정 안 하고 플래그**(정착 안 된 수치 금지).
- 한 viewer 1회 로드로 msse 사다리 순회 가능(각 점이 완전정착하면 상태가 이력 무관 결정적). 같은 msse 2회 → pointsSelected 재현으로 검증.

### ④ 동일 시점 (identical viewpoint)
- `flyToBoundingSphere`(각 viewer의 bs 의존, 우리 896 vs Eptium 854로 다름) **금지**.
- 데이터셋별 **고정 ECEF destination+orientation**을 양쪽에 `camera.setView`로 동일 적용. 시점 = 격차가 드러나는 dense 깊은 줌(데이터셋별 결정적 좌표).

### ⑤ 다중 trial + 분산
- (viewer, 점타깃)당 warm-up 1 + 본 trial N=5. 각 trial = 정적 카메라(고정), 강제 렌더, ~3s frametime.
- trial별 median → median-of-medians + IQR. **분산 > 노이즈바닥이면 그 점 "신뢰불가" 플래그.**

## 두 개의 깨질 수 있는 지점 + 가드

### 문제 1 — vsync 천장이 천장 아래 차이를 가린다
120Hz에서 p50가 8.3ms에 붙어 우리6ms↔Eptium3ms 차이가 안 보임(2026-06-20 조사에서 5M점까지 둘 다 8.3ms로 나온 함정).
- **해법**: 새 하네스가 Chromium을 직접 launch → **`--disable-gpu-vsync --disable-frame-rate-limit`** 플래그로 천장 제거 → wall-clock frametime = 실제 렌더 비용. 가벼운 점에서도 차이 드러남.
- **보조 신호**: `EXT_disjoint_timer_query_webgl2`로 GPU ms 직접 측정(가용 시). load-bearing 아님.
- **가드**: 측정 시작 시 fps가 여전히 ~120/frametime 8.3ms floor에 붙으면 **"vsync 미해제" 플래그 → 그 수치 신뢰불가**.

### 문제 2 — Eptium config 정규화가 실제로 먹히는가
Eptium 타일셋에 config를 set해도 Eptium이 매 프레임 자기 설정으로 덮어쓰면 정규화가 조용히 풀림.
- **해법**: set → 1프레임 렌더 → **read-back 검증**. 되돌아가면 rAF 루프 내 **매 프레임 재적용**.
- **가드**: 매 프레임 재적용해도 안 잡히면 → **"Eptium 정규화 불가 — verdict 무효"로 중단.** 불공정 숫자 절대 산출 안 함.

## 자기검증 (도구가 스스로를 증명)

- **ours-vs-ours 영실험(null test)**: 우리 뷰어를 자기 자신과 비교(독립 2회 로드). verdict가 **반드시 1.0(동급)**. 안 나오면 도구 편향/노이즈 → ours-vs-Eptium verdict 불신. (선택: eptium-vs-eptium)
- **결정성 체크**: 같은 config·점타깃 2회 → pointsSelected ±2% · frametime median 재현. 이 **측정된 노이즈 바닥이 "동급" 임계를 정의**(임의 숫자 아님).

## Verdict / 임계 / 메트릭 / 출력

- 점타깃별 `ratio = ours_cost / eptium_cost` (cost = vsync해제 frametime median), trial들로 신뢰구간.
- **임계 = max(±10%, 측정 노이즈바닥)**. `|ratio−1| ≤ 임계` → 동급, 밖이면 우위/열위. 노이즈바닥보다 작은 격차는 "판정 불가"로 정직 보고.
- **메트릭(점타깃별, 정착·정규화 상태)**: pointsSelected · wall-clock frametime{p50,p95,p99} · GPU ms(가용 시) · hitch · longTask · peakHeap · `totalMemoryUsageInBytes` · drawCalls(가용 시) · settle ms.
- **유효성 게이트(전부 PASS해야 verdict 단정)**: ①vsync해제 ②config readback 일치 ③완전정착(캡 미도달) ④점매칭 ±5% ⑤trial분산 ≤ 노이즈바닥 ⑥ours-vs-ours=동급. **하나라도 FAIL → "신뢰불가 + 실패 게이트" 표기, 가짜 숫자 0.**
- **출력**: `docs/bench/fair-compare-<ds>.{json,md}` — fps/ms-vs-points 곡선(양쪽)·ratio 곡선·verdict·유효성 체크리스트. 진입 `npm run bench:fair -- --ds sofi`.
- **1차 범위**: sofi(격차 드러나는 곳) + millsite.

## 검증 기준 (Acceptance Criteria)

- [ ] **AC1 (도구 무편향)**: ours-vs-ours 영실험에서 `|ratio−1| ≤ 측정 노이즈바닥` → PASS. (불통과 시 ours-vs-Eptium verdict 미발행)
- [ ] **AC2 (config 공정)**: 측정된 모든 점에서 양쪽 config read-back 일치 확인. Eptium 정규화 불가 시 verdict 무효 처리(조용한 통과 없음 — [[no-silent-failures]]).
- [ ] **AC3 (완전정착)**: 리포트에 오른 모든 점은 cap 미도달로 완전정착. 캡 도달 점은 "정착 실패"로 표기되고 verdict에서 제외.
- [ ] **AC4 (점매칭)**: 헤드라인 점타깃에서 양쪽 pointsSelected가 목표 ±5% 내, 리포트에 실측 점수 명기.
- [ ] **AC5 (분산)**: 각 보고 점은 N≥5 trial의 median-of-medians + IQR로 보고. IQR > 노이즈바닥인 점은 "신뢰불가" 표기.
- [ ] **AC6 (vsync 해제)**: 측정 frametime이 vsync floor(8.3ms)에 붙지 않음을 로그로 증명. 붙으면 "vsync 미해제"로 verdict 무효.
- [ ] **AC7 (재현)**: 한 명령(`npm run bench:fair -- --ds <ds>`)으로 전 과정 자동 실행 → JSON+md 생성, 재실행 시 verdict 동일(±노이즈바닥).

## 테스트 시나리오

- **정상**: sofi, vsync 해제, 양쪽 동일 config·고정 시점, 점타깃 4개 → 양쪽 ms-vs-points 곡선 + 점타깃별 verdict(CI 포함) + 유효성 6게이트 PASS.
- **엣지(vsync 천장)**: 가벼운 점타깃(0.5M)에서 양쪽 frametime이 floor 근처 → "이 점은 둘 다 GPU 여유, 판정 불가" 정직 표기, 무거운 점으로 판정.
- **엣지(점매칭 실패)**: 이진탐색이 ±5% 못 맞춤(데이터셋 입도 한계) → 가장 근접한 쌍 + 실제 점수 차 명기, verdict에 "근사 매칭" 라벨.
- **실패(Eptium 정규화 불가)**: 매 프레임 재적용해도 Eptium이 config 덮어씀 → verdict 발행 거부 + "Eptium 정규화 불가" 명시(부분/불공정표 금지).
- **실패(정착 미완)**: 어떤 점이 60s cap 도달 → 그 점 제외 + 플래그. 전 점 실패면 verdict 없음 + 원인 보고.

## 범위 밖 (YAGNI)

- 최적화 자체(EDL/포맷/배칭 개선) — 이 도구가 실격차 **확인 후** 별건(조건부).
- 합성 단일 점수 — 가중치 자의성으로 기각.
- autzen(너무 가벼워 vsync 해제해도 양쪽 여유일 가능성) — 필요 시 후속.
- public/심사용 패키징 — 내부 진단 도구가 1차. 신뢰 확보 후 공개 검토.
- `bench:eptium`(motion) 폐기 — "인터랙션 부드러움" 별개 유효 측정으로 존치.

## 미해결 리스크 (구현 중 스파이크로 확인)

1. `--disable-gpu-vsync`가 Playwright launch에서 실제로 먹는지(AC6로 검증).
2. Eptium이 config를 매 프레임 덮는지(문제2 가드로 처리, 최악 시 verdict 무효).
3. `EXT_disjoint_timer_query_webgl2` Chrome 가용성(없으면 vsync해제 wall-clock만).
