# 이슈 #08 전수 검증 — 기본 pointBudget=2M 회귀 (msse=8 실사용, EDL/atten ON, 실 GPU)

GL: ANGLE (Apple, ANGLE Metal Renderer: Apple M4 Pro, Unspecified Version) · budget2M = cacheBytes 16MB(실효 32) · 데이터셋 autzen·millsite·sofi

| 데이터셋 | 시점 | pointBudget | finalPts | plateau gpuMs | cesiumMB |
|---|---|---|---|---|---|
| autzen | normal | off | 2,082,516 | 48.141 | 32 |
| autzen | normal | budget2M | 2,082,516 | 47.37 | 32 |
| autzen | deep | off | 3,825,728 | 38.856 | 59 |
| autzen | deep | budget2M | 2,113,446 | 12.187 | 33 |
| millsite | normal | off | 1,418,240 | 26.022 | 22 |
| millsite | normal | budget2M | 1,418,240 | 26.021 | 22 |
| millsite | deep | off | 6,978,912 | 73.011 | 109 |
| millsite | deep | budget2M | 1,978,111 | 23.975 | 30 |
| sofi | normal | off | 1,752,719 | 28.28 | 27 |
| sofi | normal | budget2M | 1,752,719 | 28.204 | 27 |
| sofi | deep | off | 7,110,015 | 69.457 | 109 |
| sofi | deep | budget2M | 1,906,842 | 20.872 | 29 |

## 판정 (동적, 측정값 기반)
- **autzen**: 회귀 0 ✅ (정상뷰 무제한 2,082,516점 ≤ 2M → 캡 미작동) · 이득: 깊은뷰 3,825,728점/38.856ms → 2,113,446점/12.187ms
- **millsite**: 회귀 0 ✅ (정상뷰 무제한 1,418,240점 ≤ 2M → 캡 미작동) · 이득: 깊은뷰 6,978,912점/73.011ms → 1,978,111점/23.975ms
- **sofi**: 회귀 0 ✅ (정상뷰 무제한 1,752,719점 ≤ 2M → 캡 미작동) · 이득: 깊은뷰 7,110,015점/69.457ms → 1,906,842점/20.872ms

> 회귀 기준: 정상 뷰(1.0r) 무제한 점수 ≤ 2M(±5%) 또는 off≈cap → 기본 캡이 정상뷰 미작동(동작 불변). msse=8는 실사용 기본.