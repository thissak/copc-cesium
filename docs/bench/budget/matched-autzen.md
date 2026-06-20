# 매칭 예산 head-to-head — autzen · EDL/atten OFF (raw 점) (깊은 0.15r, 같은 config, 정상상태 plateau, 실 GPU)

GL: ANGLE (Apple, ANGLE Metal Renderer: Apple M4 Pro, Unspecified Version) · msse=2 · 셰이딩=EDL/atten OFF (raw 점) · ⚠️ **매칭 작동점 한정 — headline 금지**

## 매칭점 비교 (plateau = 최다프레임 버킷 = 정상상태)

| 엔진 | plateau 점수 | gpuMs | fps 천장(=1000/gpuMs) |
|---|---|---|---|
| ours (cacheBytes 10MB) | 1,300,000 | 4.491 | 223 |
| eptium (자체 예산) | 3,100,000 | 26.198 | 38 |

- 점수 매칭 오차: **58.1%** ⚠️ (>15% — 매칭 약함, 해석 주의)
- gpuMs ratio (ours/eptium): **0.171** → ours 빠름

## ours cacheBytes 스윕 (매칭점 탐색)
| cache | plateau 점수 | gpuMs | n |
|---|---|---|---|
| 3MB | 400,000 | 4.051 | 857 |
| 4MB | 500,000 | 4.62 | 1267 |
| 6MB | 800,000 | 4.731 | 821 |
| 8MB | 1,000,000 | 3.946 | 669 |
| 10MB | 1,300,000 | 4.491 | 917 |

> 정직성: 매칭점 한정 결과. 셰이딩=EDL/atten OFF (raw 점), globe off·res=1. gpuMs=GPU 타이머(vsync 무관).
> 한계: viewpoint=각 bs×0.15(ECEF 중심 동일, 반경 차이 가능). Eptium plateau 는 뷰포트 의존(회차 변동). EDL on 시 양 엔진 각자 네이티브 셰이딩(파라미터 미정합).