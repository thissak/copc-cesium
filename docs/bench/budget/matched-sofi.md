# 매칭 예산 head-to-head — sofi (깊은 0.15r, 같은 config, 정상상태 plateau, 실 GPU)

GL: ANGLE (Apple, ANGLE Metal Renderer: Apple M4 Pro, Unspecified Version) · msse=2 · ⚠️ **매칭 작동점 한정 — headline 금지**

## 매칭점 비교 (plateau = 최다프레임 버킷 = 정상상태)

| 엔진 | plateau 점수 | gpuMs | fps 천장(=1000/gpuMs) |
|---|---|---|---|
| ours (cacheBytes 4MB) | 500,000 | 5.721 | 175 |
| eptium (자체 예산) | 600,000 | 14.163 | 71 |

- 점수 매칭 오차: **16.7%** ⚠️ (>15% — 매칭 약함, 해석 주의)
- gpuMs ratio (ours/eptium): **0.404** → ours 빠름

## ours cacheBytes 스윕 (매칭점 탐색)
| cache | plateau 점수 | gpuMs | n |
|---|---|---|---|
| 4MB | 500,000 | 5.721 | 899 |
| 6MB | 800,000 | 5.236 | 1704 |
| 8MB | 1,000,000 | 5.711 | 2210 |
| 10MB | 1,300,000 | 5.966 | 3074 |

> 정직성: 매칭점 한정 결과. config=globe off·EDL off·atten off·res=1(fair-probe normalizeConfig). gpuMs=GPU 타이머(vsync 무관).
> 한계: viewpoint=각 bs×0.15(ECEF 중심 동일, 반경 차이 가능). Eptium plateau 는 뷰포트 의존(회차 변동).