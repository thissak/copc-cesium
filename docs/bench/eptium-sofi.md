# Eptium 오라클 벤치 — sofi

> 측정 2026-06-18T07:16:45.181Z · 데이터 `sofi` · **msse=4** · 스트레스 18s · 네트워크 none
> 우리 GL: `ANGLE (Apple, ANGLE Metal Renderer: Apple M4 Pro, Unspecified Version)` · Eptium GL: `ANGLE (Apple, ANGLE Metal Renderer: Apple M4 Pro, Unspecified Version)`

## 품질 정규화 증인 (이게 안 맞으면 아래 비교 무효)

| 증인 | ours | eptium |
|------|------|--------|
| msse | 4 | 4 |
| numberOfPointsSelected | 4,291,095 | 8,446,625 |
| tilesReady / total | 188/8547 | 361/13281 |

## Tier 1a — 북극성 (재현·자동, 낮을수록 좋음 ↓)

| 지표 | ours | eptium | Δ(ours vs eptium) |
|------|------|--------|-------------------|
| TTD 풀레솔 도달 | 29228 ms | 24535 ms | +19% |
| 네트워크 bytes | 0.4 MB | 85.1 MB | -100% |
| range 요청 수 | 61 | 479 | -87% |
| peak heap | 258 MB | 288 MB | -10% |

## Tier 1b — 부드러움 보조 (frametime, 낮을수록 좋음 ↓)

| 지표 | ours | eptium | Δ |
|------|------|--------|---|
| frametime p50 | 8 ms | 8 ms | +1% |
| frametime p95 | 23 ms | 10 ms | +128% |
| hitch >50ms 수 | 1 | 1 | +0% |
| longTask 합(ms) | 219 ms | 0 ms | n/a |

## Tier 2 — fps (실GPU headed, 보조; headless면 무효)

fps≈1000/p50 — ours **119** · eptium **120.5**. 자동화 브라우저 fps라 2급. headless swiftshader면 이 줄 무시.

## ⚠️ 측정 한계
- numberOfPointsSelected 큰 차이: ours=4,291,095 vs eptium=8,446,625 (49% 차). msse 정규화가 품질을 동등하게 맞추지 못함. 1a 비교는 참고용.
- ours reqCount/bytesTotal은 main-thread S3 요청만 집계(헤더 3회). 타일 content는 Web Worker→SW 경유 S3 range 요청이라 CDPSession에서 보이지 않음.
