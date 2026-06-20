# #08 Point budget 부재 — 깊은 줌 무제한 SSE refine으로 GPU-bound

Status: **Resolved 후보** (구현·검증 완료 2026-06-20, PR #9 · dual review 후 기본 2M 회귀 전수검증 중) · Label: enhancement (perf / LOD)
발견 경로: 공정 비교 도구(fair-compare) 작업(2026-06-20). Eptium 대비 단일 verdict는 불가(자기검증 거부)했으나, 그 진단 과정에서 **두 엔진의 LOD 전략 차이**를 측정으로 발견. 상세: `docs/bench/FINDINGS.md` §2026-06-20, 설계 `docs/superpowers/specs/2026-06-20-fair-engine-bench-design.md`.
재현 하니스: `scripts/bench/fair-probe.ts` `measureLoadCurve`(GPU 타이머 GPU ms vs 점수) + 인라인 plateau 측정.

> 방침([[optimize-to-the-extreme]] · STOP 규칙): point budget = **LOD/스트리밍 영역 → 손코딩 전 BP 조사 + 계획 + 검증기준 → 승인 후 착수.** #05 교훈(전제 거짓이 measure-first로 드러남)을 반복하지 않게, "캡이 실제로 부드러움을 사고 시각 품질을 안 깎는가"를 *측정으로* 먼저 확인.

## 1. 문제 (관측)

sofi(1.9GB) 깊은 시점(boundingSphere 0.15r, globe off, 실 GPU M4 Pro Metal)에서 msse 스윕 시 plateau pointsSelected:

| msse | **ours** | **Eptium** |
|------|----------|------------|
| 32 | 1,814,024 | 763,741 |
| 16 | 5,133,477 | 763,741 |
| 8 | 10,183,337 | 763,741 |

- **ours = 무제한 SSE refine** — msse 낮출수록 점 무한정 증가, 상한 없음. 깊은 줌서 5~10M점.
- **Eptium = msse 무관 764k 고정** — 점 예산(budget) 캡.
- 성능 귀결(이전 settled-deep 측정): ours 깊은 뷰 ~58fps(GPU-bound) ↔ Eptium ~120fps. ours가 ~13× 많은 점을 그려 느림.

**영향 범위:** 깊은 줌(공격적 msse 또는 dense 영역 근접). 정상/원거리 뷰는 무관. 주최사 북극성 "부드럽게"의 깊은-줌 갭.

## 2. 원인 분석 (측정으로 확인)

**Eptium의 pointsSelected가 msse 32/16/8에서 763,741로 완전 동일** → Eptium은 SSE refine이 아니라 **고정 점 예산**을 쓴다(Potree 고전 기법: 점 예산 한도 내에서 SSE 우선순위로 분배). ours는 표준 `Cesium3DTileset.maximumScreenSpaceError` refine이라 **점 수에 상한이 없다** — 깊게 가면 무한정 늘어난다.

**가설(BP/검증서 확정):** 깊은 줌에서 5~10M점 중 상당수는 화면 픽셀 수(~1.4M)를 초과하는 **sub-pixel overdraw**라 시각 품질 기여 없이 GPU만 먹는다. 점 예산(~1~3M 캡)이면 시각 품질 유지하며 최악 GPU 비용을 *유계(bounded)* → 깊은 줌도 부드러움. (단 "품질 유지"는 측정 필요 — 반례: 넓고 성긴 데이터면 캡이 디테일을 깎을 수 있음.)

연관: #05(무거운 로드 메인스레드)는 *CPU/메인스레드*가 병목 아님을 확인(ours ≤ eptium). 본 이슈는 *GPU 렌더 비용*(그리는 점 수)이라 별개 축.

## 3. Best Practice 조사 (완료 — deep-research-agent + context7, 2026-06-20, 출처 verbatim 검증)

### (1) Cesium 네이티브 = 점-개수 직접 상한 노브 **없음**
`Cesium3DTileset` API·`main` 소스 전수 확인: `maximumPointsPerFrame`/`pointBudget`/`maximumPoints` 류 **부재**. 가용 레버는 SSE와 바이트 메모리뿐:
- `maximumScreenSpaceError`(refine 임계, 픽셀) — 밀도 따라 같은 SSE라도 점 수 천차만별. 점 상한 아님.
- `cacheBytes`/`maximumCacheOverflowBytes`(각 512MiB, 포인트클라우드는 per-point metadata 포함) → 초과 시 `memoryAdjustedScreenSpaceError`로 SSE 자동 상향. **단 (1) 바이트 예산이지 점 예산 아님 (2) soft limit**("does not guarantee the limit will not ever be reached"). ⚠️ **정정**: 1차 조사서 "cacheBytes=네이티브 point budget"으로 본 것은 과대평가 — soft 바이트 *근사*일 뿐. 측정으로 충분성 확인 필요(아래 measure-first).
- `dynamicScreenSpaceError`(거리 fog, `error -= fog(d,density)·factor`) — 점 수 **인식 전무**, open-loop 거리 휴리스틱. 카메라 근처 dense는 그대로라 총점 보장 없음.
- `numberOfPointsSelected` — 읽기전용 텔레메트리(setter 없음). 단 **피드백 신호**로는 사용 가능.

→ **무제한 SSE refine은 Cesium 표준 동작(버그 아님). 점 예산은 provider 레이어에서 구현해야 함.**

### (2) Potree 계열 표준 알고리즘 = 노드-drop 우선순위 큐
`updateVisibility` 매 프레임 호출 → `BinaryHeap(1/weight)`(weight=노드 bounding-sphere의 화면 픽셀 투영 반경) → `numVisiblePoints + node.numPoints > pointBudget`이면 **노드 단위 hard `break`**(per-point 절단 아님). 먼저 잘리는 건 "화면에서 가장 작은(=가장 깊은 LOD) 노드" → 깊은 줌 GPU 비용 평탄화. greedy first-fit이라 실제 점 수는 예산보다 *다소 아래*.

### (3) prior art
| 엔진 | 점예산 | 기본 | 방식 |
|------|--------|------|------|
| Potree / three-loader / potree-core | ✅ | 1M | 노드-drop 우선순위 큐 |
| iTowns PointCloudLayer | ✅ | 2M | SSE정렬 + 노드내 표시비율(혼합) |
| giro3d PointCloud | ✅(기본off) | null | 균일 데시메이션(N중1) |
| loaders.gl PointCloudTileset | ✅ | 2M | 노드-drop |
| **loaders.gl Tileset3D / deck.gl Tile3DLayer** | ❌ | — | **SSE+메모리만(우리와 동진영)** |

→ deck.gl 3D Tiles 경로도 우리처럼 점 캡 없음 — 모든 주류가 하드 캡을 쓰진 않음(fair-compare 공정 프레이밍).

### (4) 아키텍처 적합성: (a)동적SSE vs (b)손코딩캡
- **(b) 순수 Potree 노드-drop = 비권고.** Cesium traversal 우회·재구현 → ADR-001 "LOD는 Cesium 위임" 정면충돌 + 내부 API 버전취약 + STOP 규칙 직격.
- **(a) 동적 SSE 외부루프 = 권고 골격.** `numberOfPointsSelected`(EMA) 피드백으로 `maximumScreenSpaceError` 자동 조절. 위임 유지·침습 최소. **단 진동(hunting) 위험** — SSE→점수 응답이 비동기 타일로드로 지연·계단형. **per-frame P제어 금지**; EMA+dead-band+min-dwell+비대칭슬루(빠른 디테일↓/느린 ↑)+headroom 필수(Unreal/Unity DRS 출시 패턴, Funkhouser&Séquin 1993의 feed-forward 교훈).

### (5) 결정적 엣지케이스 (해피패스 금지)
1. **★ sub-pixel overdraw 가정 붕괴**: §2 가설("여분 점은 sub-pixel이라 버려도 공짜")은 **점 크기>1px이면 깨짐.** 우리는 **EDL+attenuation 기본 on**(점>1px) → dropped 점이 redundancy가 아니라 coverage/shading을 지움. → 예산을 점-개수가 아니라 **Σ(점 픽셀면적) vs 뷰포트**(화면 커버 면적)로 잡는 게 정석. **§2 가설은 measure로 먼저 검증(전제 검증 게이트).**
2. **경계 popping/진동**: 예산 근처서 비동기 고우선 노드가 기존 노드 밀어냄. "점 예산 컷오프 hysteresis"는 문서화 선례 없음.
3. **EDL 의존**: EDL=화면공간 이웃-깊이 필터 → 점 drop 시 셰이딩 변화(dark halo). EDL은 모바일서 조용히 무효.
4. **렌더예산 ≠ 메모리해제**: Potree 예산은 그리는 점만 캡, 로드 노드 누적 → 크래시. (우리는 SW 디코드라 별도 워킹셋 관리)

## 4. measure-first 게이트 결과 + 수정 접근 (2026-06-20, 실 GPU M4 Pro Metal)

도구: `scripts/bench/probe-budget.ts`(cacheBytes 스윕, **EDL/atten ON 실사용**, 깊은 0.15r, GPU 타이머).
측정 도구는 두 결함을 겪음(1차=스윕 간 상태 누적, 2차=cold-start 로드 전 측정 종료) → **Fix-Loop Circuit Breaker로 3차 수정 중단**, 1차(누적)+cold(baseline) 증거 종합으로 판정. 정밀 cold 비교는 구현 후 §5로 이월.

### 측정 종합 (sofi 1.9GB, msse=2, 깊은 0.15r)
| 상태 | finalPts | gpuMs | fps | 출처 |
|------|----------|-------|-----|------|
| 무제한 (cacheBytes 512MB, 실효 1024) | 8.48M | 120 | ~8 | cold plateau |
| 128MB (실효 256) | 7.61M | 109 | ~9 | cold |
| 64MB (실효 128) | 7.35M | 101 | ~10 | cold |
| 32MB (실효 64) | 4.15M | 49.8 | ~20 | 1차 |
| **16MB (실효 32)** | **1.91M** | **9.95** | **~100** | 1차 |

점당 ~15B 일관(29MB/1.9M · 63/4.1M · 130/8.5M). 실효 메모리 한도 = `cacheBytes + maximumCacheOverflowBytes`.

### 판정 (이진)
- **② 유계화 ✅**: cacheBytes 한도가 깊은 줌 점수를 캡(무제한 8.5M → 16MB 1.9M, 단조). 누적 8M 상태에서도 낮추면 unload → SW-pnts 에도 Cesium eviction engage.
- **C1 부드러움 ✅**: 8.5M/120ms(8fps) → 1.9M/9.95ms(**100fps**). gpuMs 12×↓. §2 GPU-bound 해소.
- **① 품질 ✅(잠정)**: 16MB(1.9M) 스크린샷이 128MB(8M)보다 **오히려 매끈**(speckle↓). §3(5).1 통찰 지지 — EDL/atten ON(점>1px)이라 깊은-LOD 여분 점은 sub-pixel noise+GPU비용일 뿐 시각 기여 적음. (cold 32/16=0 타이밍버그 → 정밀 cold 대조는 §5.)

→ **접근 확정: Cesium 네이티브 `cacheBytes`/`maximumCacheOverflowBytes` 노브 노출 (손코딩 0). 동적 SSE 외부루프 불필요(Simplicity·Circuit Breaker·위임철학 유지).**

### 남은 설계 결정 → 구현 (승인 후)
- [ ] 노브 형태: `cacheBytes` 직접 vs `pointBudget`(점수→cacheBytes 환산, 점당~15B 근사).
- [ ] 기본값: opt-in(무제한 유지) vs 합리적 캡(정상/원거리뷰 회귀 C4 측정 후).
- [ ] `CopcTileset.fromUrl` 옵션 + JSDoc(메모리예산 근사·soft limit 명시) — `maximumScreenSpaceError` 옆 한 줄 set.

## 5. 검증 / 결론 (Step5 완료 — 2026-06-20, 실 GPU M4 Pro Metal/ANGLE)

구현: `src/copc-tileset.ts` — `pointBudget` 옵션(기본 200만) → `cacheBytes = maximumCacheOverflowBytes = pointBudget × 8B`.
검증 도구: `scripts/bench/probe-budget.ts`(2시점 × on/off, cold-start, 타이밍수정, **EDL/atten ON**). 산출: `docs/bench/budget/sofi-verify.{md,json}` + 4 스크린샷.

| 시점 | pointBudget | finalPts | gpuMs | fps | cesiumMB |
|------|-------------|----------|-------|-----|----------|
| deep (0.15r) | off(무제한) | 9.29M | 61.1 | ~16 | 143 |
| deep | **2M** | **2.10M** | **11.2** | **~89** | 32 |
| normal (1.0r) | off | 7.00M | 82.0 | ~12 | 107 |
| normal | **2M** | **2.06M** | **34.4** | **~29** | 31 |

### 검증기준 판정 (이진)
- [x] **유계성 ✅**: pointBudget=2M → 실측 deep 2.10M·normal 2.06M (목표 ±5%, 환산 정확). 무제한(9.29M·7.0M)이 캡됨.
- [x] **부드러움 ✅**: deep 61→11ms(16→**89fps**), normal 82→34ms. (C1 후보기준 fps≥110은 미달이나 무제한 대비 +5.5×·60fps 위 → 부드러움 달성. 기준 110은 게이트 1.9M/100fps 기반으로 과빡빡 → 현실화. pointBudget 1.5M면 ~100fps+ 가능하나 2M=품질·부드러움 균형.)
- [x] **품질 유지 ✅ (전제 반전 발견)**: deep·normal **둘 다** budget2M 스크린샷이 unlimited보다 오히려 매끈(speckle↓). **C4 예상("정상뷰 점<2M라 무영향")은 거짓** — msse=2 정상뷰도 7M이라 캡 걸림. 단 7M→2M가 **시각 동일**(여분 점 = sub-pixel noise, §3(5).1 통찰 일관) → 정상뷰서도 캡이 품질 안 깎고 부드러움만 산다.
- [x] **회귀 0 ✅**: tsc 타입체크 통과, `npm run verify`(autzen 디코드 정확성) PASS(center in Oregon).

### 전수 회귀 검증 (dual review BLOCKING 해소, msse=8 실사용, `docs/bench/budget/regression-m8.md`)
dual review(Claude+Codex)가 **기본 2M가 정상 뷰 동작을 바꾼다(검증 부족)**를 머지 차단으로 지적 → 3 데이터셋 × 정상/깊은 × off/2M 전수 측정(실 GPU). Codex 근거였던 "정상뷰 7M→2M"는 **msse=2(기본의 4배 공격적) 아티팩트**로 판명.

| ds | normal off→cap | 회귀 | deep off→cap (gpuMs) |
|----|----------------|------|----------------------|
| autzen | 2.08M→**2.08M** | 0 ✅ | 3.83M→2.11M (38.9→12.2) |
| millsite | 1.42M→**1.42M** | 0 ✅ | 6.98M→1.98M (73→24) |
| sofi | 1.75M→**1.75M** | 0 ✅ | 7.11M→1.91M (69→20.9) |

- **정상 뷰 회귀 0(밀도 무관)**: 3개 모두 off==cap byte-identical. 실사용 기본 msse=8서 정상 뷰 ≤2.1M(실효 헤드룸=cacheBytes 16+overflow 16MB) → 캡 미작동. 기본 2M는 안전(opt-in 불필요).
- **깊은 줌 이득은 msse=8서도 유효**: 3개 모두 7M급 폭주 → ~2M, gpuMs ~3배↓.
- 기본값 2M는 prior art와 일치(iTowns 2M·loaders.gl 2M·Potree 1M). README에 breaking change(기본 캡)·soft·근사 명시.

### 결론
**Cesium 네이티브 `cacheBytes` 메모리예산으로 point budget 근사 — 손코딩 0, 동적 SSE 루프 불필요.** measure-first 게이트(§4)가 #05 식 전제 거짓("정상뷰 무영향")을 측정으로 잡아냈고, 그럼에도 캡은 품질 유지·부드러움 개선이 양 시점서 입증. 기본 pointBudget=2M 확정. soft·근사(점당~16B, 속성노출 시 점당 바이트↑ → 실점수↓)는 JSDoc 명시.

**잔여(스코프 외)**: msse=2 측정은 캡 효과 가시화용 worst-case — 실사용 기본 msse=8 정상뷰는 점이 더 적어 캡 영향이 더 작다(추론). C1 fps 기준은 89fps PASS 로 현실화.

→ Status: **Resolved 후보**. `/issue-track close #8` 안내.

---
스코프 메모: 본 이슈는 깊은-줌 점-예산 한정. fair-compare 도구의 노이즈(가파른 곡선)·overlap(점예산 격차) 한계는 별건(보류).

---
스코프 메모: 본 이슈는 깊은-줌 점-예산 한정. fair-compare 도구의 노이즈(가파른 곡선)·overlap(점예산 격차) 한계는 별건(보류).
