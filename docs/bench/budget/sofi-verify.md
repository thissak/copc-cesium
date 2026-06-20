# 이슈 #08 Step5 검증 — pointBudget 2M on/off × 깊은/정상 (sofi, EDL/atten ON, 실 GPU)

GL: ANGLE (Apple, ANGLE Metal Renderer: Apple M4 Pro, Unspecified Version) · msse=2 · budget2M = cacheBytes 16MB(실효 32)

| 시점 | pointBudget | finalPts | plateau gpuMs | cesiumMB |
|---|---|---|---|---|
| deep | unlimited | 9,287,184 | 61.075 | 143 |
| deep | budget2M | 2,098,011 | 11.241 | 32 |
| normal | unlimited | 6,998,297 | 81.999 | 107 |
| normal | budget2M | 2,061,583 | 34.407 | 31 |

## 판정 (이진)
- **C1 부드러움(deep)**: unlimited 61.075ms(9,287,184점) → budget2M 11.241ms(2,098,011점). gpuMs↓ → ✅
- **C4 회귀(normal)**: unlimited 6,998,297점 vs budget2M 2,061,583점. ⚠️ 예상과 달리 정상뷰도 7M(>2M)이라 캡 걸림(msse=2 공격적 refine). 단 7M→2M가 **스크린샷 시각 동일**(sofi-normal-*.png — 여분 점=sub-pixel noise) + gpuMs 82→34ms → **품질 회귀 없음·부드러움↑ ✅**
- **① 품질(deep)**: sofi-deep-unlimited.png vs sofi-deep-budget2M.png — 점 줄여도 커버/실루엣 회귀 ≤ 임계 → ✅