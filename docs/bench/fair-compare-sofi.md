# Fair Engine Bench — sofi

> 로딩 곡선 샘플링 · 동일 config · 고정 시점 · cost=GPU 타이머 GPU ms. 노이즈바닥=8.4%

## 유효성 게이트: ❌ 일부 FAIL → verdict 신뢰불가

- ✅ gpuMsOk
- ✅ configHeld
- ❌ overlapOk
- ✅ nullTestOk

## Verdict (신뢰불가 — 게이트 실패) — 공통 점 버킷별 GPU ms

| 점 버킷 | ours GPU ms | eptium GPU ms | ratio | 판정 |
|---|---|---|---|---|
| 250,000 | 5.94 | 11.225 | 0.529 | 우위(우리가 빠름) |
| 500,000 | 6.109 | 11.405 | 0.536 | 우위(우리가 빠름) |

## 곡선 (GPU ms @ pointsSelected)

**ours** (ANGLE (Apple, ANGLE Metal Renderer: Apple M4 Pro, Unspecified Version)) gpuOk=true finalPts=1,906,842
| 점 버킷 | GPU ms median | n |
|---|---|---|
| 250,000 | 5.94 | 415 |
| 500,000 | 6.109 | 157 |
| 750,000 | 6.228 | 221 |
| 1,000,000 | 6.984 | 118 |
| 1,250,000 | 53.535 | 43 |
| 1,500,000 | 65.524 | 14 |
| 1,750,000 | 6.316 | 1165 |
| 2,000,000 | 7.25 | 5156 |

**eptium** (ANGLE (Apple, ANGLE Metal Renderer: Apple M4 Pro, Unspecified Version)) gpuOk=true finalPts=437,014
| 점 버킷 | GPU ms median | n |
|---|---|---|
| 250,000 | 11.225 | 11 |
| 500,000 | 11.405 | 60 |

## 영실험 (ours-vs-ours)

✅ ours-vs-ours = 동급 → 도구 무편향 확인
