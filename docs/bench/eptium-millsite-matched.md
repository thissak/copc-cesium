# Eptium 오라클 벤치 — millsite

> 측정 2026-06-18T01:35:10.496Z · 데이터 `millsite` · **msse=32** · 스트레스 12s · 네트워크 none
> 우리 GL: `ANGLE (Apple, ANGLE Metal Renderer: Apple M4 Pro, Unspecified Version)` · Eptium GL: `ANGLE (Apple, ANGLE Metal Renderer: Apple M4 Pro, Unspecified Version)`

## 품질 정규화 증인 (이게 안 맞으면 아래 비교 무효)

| 증인 | ours | eptium |
|------|------|--------|
| msse | 8 | 14 |
| numberOfPointsSelected | 712,458 | 757,536 |
| tilesReady / total | 57/3588 | 53/3590 |

## Tier 1a — 북극성 (재현·자동, 낮을수록 좋음 ↓)

| 지표 | ours | eptium | Δ(ours vs eptium) |
|------|------|--------|-------------------|
| TTD 풀레솔 도달 | 13900 ms | 4063 ms | +242% |
| 네트워크 bytes | 0.2 MB | 8.5 MB | -98% |
| range 요청 수 | 3 | 60 | -95% |
| peak heap | 59 MB | 144 MB | -59% |

## Tier 1b — 부드러움 보조 (frametime, 낮을수록 좋음 ↓)

| 지표 | ours | eptium | Δ |
|------|------|--------|---|
| frametime p50 | 8 ms | 8 ms | +0% |
| frametime p95 | 9 ms | 10 ms | -8% |
| hitch >50ms 수 | 0 | 0 | n/a |
| longTask 합(ms) | 0 ms | 0 ms | n/a |

## Tier 2 — fps (실GPU headed, 보조; headless면 무효)

fps≈1000/p50 — ours **120.5** · eptium **120.5**. 자동화 브라우저 fps라 2급. headless swiftshader면 이 줄 무시.

## ⚠️ 측정 한계
- msse 불일치: ours=8 vs eptium=14. Cesium의 msse=32는 full-cloud 거리에서 타일 0개를 요청(허용 SSE가 너무 크다). ours는 자연값 msse=8로 측정. 직접 비교 시 이 차이 감안 필요.
- ours reqCount/bytesTotal은 main-thread S3 요청만 집계(헤더 3회). 타일 content는 Web Worker→SW 경유 S3 range 요청이라 CDPSession에서 보이지 않음.
