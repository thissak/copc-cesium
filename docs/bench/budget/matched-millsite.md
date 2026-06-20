# 매칭 예산 head-to-head — millsite · EDL/atten OFF (raw 점) (깊은 0.15r, 같은 config, 정상상태 plateau, 실 GPU)

GL: ANGLE (Apple, ANGLE Metal Renderer: Apple M4 Pro, Unspecified Version) · msse=2 · 셰이딩=EDL/atten OFF (raw 점) · ⚠️ **매칭 작동점 한정 — headline 금지**

## 매칭점 비교 (plateau = 최다프레임 버킷 = 정상상태)

| 엔진 | plateau 점수 | gpuMs | fps 천장(=1000/gpuMs) |
|---|---|---|---|
| ours (cacheBytes 3MB) | 400,000 | 4.456 | 224 |
| eptium (자체 예산) | 400,000 | 9.955 | 100 |

- 점수 매칭 오차: **0.0%** ✅ (≤15% — 매칭 성립)
- gpuMs ratio (ours/eptium): **0.448** → ours 빠름

## ours cacheBytes 스윕 (매칭점 탐색)
| cache | plateau 점수 | gpuMs | n |
|---|---|---|---|
| 3MB | 400,000 | 4.456 | 868 |
| 4MB | 500,000 | 4.882 | 1554 |
| 6MB | 800,000 | 4.823 | 1714 |
| 8MB | 1,000,000 | 4.828 | 2875 |
| 10MB | 1,300,000 | 5.484 | 3362 |

> 정직성: 매칭점 한정 결과. 셰이딩=EDL/atten OFF (raw 점), globe off·res=1. gpuMs=GPU 타이머(vsync 무관).
> 한계: viewpoint=각 bs×0.15(ECEF 중심 동일, 반경 차이 가능). Eptium plateau 는 뷰포트 의존(회차 변동). EDL on 시 양 엔진 각자 네이티브 셰이딩(파라미터 미정합).