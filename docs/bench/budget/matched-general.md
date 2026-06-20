# 매칭 head-to-head 일반화 — 다중 ds·전 작동점 (EDL/atten OFF (raw 점), 깊은 0.15r, 정상상태, 실 GPU)

GL: ANGLE (Apple, ANGLE Metal Renderer: Apple M4 Pro, Unspecified Version) · msse=2 · 데이터셋 autzen·millsite·sofi · ⚠️ **매칭 작동점 한정, Eptium plateau run변동**

## 데이터셋별 매칭점 비교
| ds | ours (점수/gpuMs/fps) | eptium (점수/gpuMs/fps) | ratio | 매칭오차 | ours 곡선 평탄(max/min) |
|---|---|---|---|---|---|
| autzen | 1,300,000/4.491/223 | 3,100,000/26.198/38 | **0.171** | 58% | 1.2× |
| millsite | 400,000/4.456/224 | 400,000/9.955/100 | **0.448** | 0% | 1.23× |
| sofi | 400,000/4.33/231 | 400,000/9.98/100 | **0.434** | 0% | 1.27× |

## 판정 (전 작동점·다중 ds)
- **AC1 다중 ds 우위**: ✅ 전 데이터셋서 ours ratio<1 (Eptium보다 빠름)
- **AC2 전 작동점(곡선 평탄)**: ✅ 전 ds서 ours gpuMs max/min ≤2× — 우위가 한 점 아닌 전 점수 범위
- **AC3 정직**: Eptium plateau 는 뷰포트·회차 의존(단일 run). 매칭 작동점·실 GPU 1대·EDL/atten OFF (raw 점) 한정. ours 점수는 cacheBytes 결정론.

> 각 ds 상세: matched-{ds}.md. ours 곡선 평탄=점수 바꿔도 gpuMs 거의 불변 → "전 작동점" 근거.