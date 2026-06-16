# 측정 결과 (Results)

> 추측이 아니라 측정. 모든 수치는 재현 가능한 하네스(`npm run verify` / `npm run sweep`)에서 나온다.
> 데이터셋: Autzen (`s3.amazonaws.com/hobu-lidar/autzen-classified.copc.laz`, 81.1MB, full 10.65M점)

## 측정 환경

| | |
|--|--|
| 데이터 파이프라인 | Node 22 (헤드리스, `tsx`), macOS, S3(us) range 요청 |
| 브라우저(참고) | headless Chromium (Playwright) — **GPU=software(swiftshader)라 fps는 비신뢰** |
| 날짜 | 2026-06-16 |

!!! warning "헤드리스 fps 한계"
    내 검증 환경의 브라우저는 **소프트웨어 렌더링**이라 실제 GPU fps를 대표하지 못한다.
    → 렌더축(④) fps의 정량 비교는 **실제 GPU 머신**에서 별도 측정 필요. 여기서 신뢰 가능한 것은
    **데이터축(①②③) 시간·메모리**와 **네트워크 거동(range 요청 수/바이트)**.

## C1 — 정확성 (PASS ✅)

`npm run verify` (Autzen, 50k점):

```json
{
  "pointCount": 50000,
  "crs": "COMPD_CS[\"NAD83 / Oregon GIC Lambert (ft) + NAVD88 height (f",
  "center": { "lon": -123.06875, "lat": 44.05591 },
  "heightM": { "min": 123.9, "max": 187.5 }
}
C1 PASS ✅  center is in Oregon
```

center **-123.069°, 44.056°** = 실제 Autzen Stadium(44.058°N, 123.068°W)과 소수점 4자리 일치. georef 정확.

## C2 (데이터축) — 성능 스윕

`npm run sweep` (Autzen, 점 예산 증가):

| budget | points | loadMs | ms/1M | arrayMB | rssMB |
|--------:|--------:|--------:|-------:|--------:|------:|
| 50k | 50k | 2,394 | 47,879 | 1.5 | 124 |
| 250k | 250k | 2,867 | 11,468 | 7.6 | 157 |
| 1M | 1M | 8,937 | 8,937 | 30.5 | 183 |
| 2.5M | 2.5M | 23,654 | 9,462 | 76.3 | 265 |
| 5M | 5M | 41,285 | 8,257 | 152.6 | 343 |
| 10.65M (full) | 10.65M | 85,757 | 8,050 | 325 | 588 |

**해석:**

1. **선형(O(N)), 무릎/에러 없음** → 데이터 파이프라인 자체는 안 무너진다. 메모리 정확히 **32 byte/점**(상한 없음).
2. **느리다**: 한계비용 **~8s/100만점**. full Autzen = **86초**. (작은 budget의 큰 ms/1M은 create 1.4s + hierarchy 고정비)
3. georef(proj4 ③)는 무시 가능(100k에 11ms) → 8s/M는 **fetch+decode(①②)**. Node가 브라우저(149ms/100k)보다 ~6배 느리고 노드를 **순차(await)** 로 받음 → **① 순차 range 지연**이 유력.

→ **데이터축엔 벽이 없다(선형).** 인터랙티브를 죽이는 건 렌더축 — 아래에서 실 GPU로 확정.

## C2 (렌더축) — 실 GPU (Apple Metal, Autzen, `?bench`)

| points | buildMs | fps | heapMB |
|--------:|--------:|----:|-------:|
| 100k | 14 | 117 | 143 |
| 250k | 23 | 120 | 220 |
| 500k | 51 | 120 | 721 |
| 1M | 101 | **74** | 1,258 |
| 2M | 423 | **40** | 2,098 |
| 4M | 1,129 | **17** | 3,986 |

**C2-1 벽 N ≈ 2~3M점** — fps 1M(74)→2M(40)→4M(17), 인터랙티브(30fps) 교차 ~2.5M.

**C2-2 지배 축 — GPU 아님. `PointPrimitiveCollection`(편의 API) 점당 오버헤드:**

1. **메모리(가장 단단한 천장)**: 4M = **3,986MB ≈ 1KB/점** (원시 점 데이터는 128MB뿐 → 30배 부풀음). 4M 위에서 OOM.
2. **③ build 초선형**: 1M 101ms → 2M 423ms(점 2배·시간 4배) → 4M 1,129ms. 일회성 스톨.
3. **④ per-frame**: frame time 13→25→59ms 선형 증가.

→ **GPU 원시 throughput이 병목이 아니다.** 편의 API의 CPU·메모리 오버헤드가 먼저 죽인다.
이는 Phase 2 방향을 못박는다: **컴팩트 typed buffer(점당 객체 제거) + LOD 스트리밍** 둘 다 필요.

## Phase 2 스파이크 — 다리 존재 증명 (PASS ✅, 2026-06-16)

가장 큰 허들 ①(Cesium에 런타임 생성 content 먹이기)을 최소 스파이크로 디리스킹. (`?spike`, `src/pnts.ts`)

```json
{ "points": 50000, "pntsBytes": 750184,
  "tileLoaded": 1, "tileFailed": 0,
  "centerLonLat": [-123.06874, 44.05591], "bridge": "OK ✅" }
```

- **S1 ✅** 메모리에서 직접 만든 pnts 타일을 **파일/서버 없이 data URI**로 `Cesium3DTileset`에 먹임 → `tileLoad:1, tileFailed:0` = **Cesium이 우리 content를 거부 없이 파싱·로드.** (`tileLoad`는 스크린샷보다 강한 증거 — 매직·Feature Table 파싱 성공)
- **S2 ✅** `RTC_CENTER`로 좌표 = Autzen Oregon 정확. (정밀도 메커니즘 작동; 시각 jitter 정밀확인은 실 GPU)
- **S3 ✅** 헤드리스 콘솔로 검증.
- 한계: 헤드리스라 "픽셀이 정확히 그려졌나"까지는 단정 불가 — 단 content-accepted + 위치-정확 신호는 강함.

→ **핵심 난관이 data URI로 뚫림.** 남은 Phase 2는 "알려진 배관"(옥트리→동적 tileset 트리 + 온디맨드 공급 + 워커 디코드 + LRU). 단 data URI는 전부 미리 만들어야 하므로, **진짜 스트리밍은 서비스워커/blob 온디맨드로** 확장 필요.

## 레퍼런스 기준점 (같은 Autzen, 2026-06-16)

같은 Autzen URL을 기존 뷰어에 물려 거동 측정 (Playwright). **신뢰 축 = 네트워크 거동**(fps는 헤드리스 한계).

| 뷰어 | 스택 | 결과 |
|------|------|------|
| **viewer.copc.io** (타깃, Cesium) | Cesium(상용 Eptium 계열) | **측정 불가 — 522 Connection timed out (서버 다운)** |
| **lidar-viewer.gishub.org** (오픈 피어) | **deck.gl + loaders.gl** (loaders.gl이 copc.js 사용), Cesium 아님 | 아래 |

**lidar-viewer (deck.gl) 거동:**

- **HTTP range 206 스트리밍** — 12초간 Autzen URL로 **9개 부분 요청**만으로 초기 화면 렌더. **전체 81MB를 안 받음** (보이는 LOD만).
- fps ~120 (헤드리스 software GPU라 비신뢰 — 다만 스트리밍된 LOD에선 안 버거워함을 시사).
- 바이트 정량화는 S3 cross-origin TAO 미설정으로 Resource Timing=0 → 요청 수로 대체.

### 우리(naive) vs 레퍼런스(LOD 스트리밍)

| 축 | 우리 naive baseline | 레퍼런스 (deck.gl) |
|----|---------------------|--------------------|
| 데이터 취득 | 노드 **순차 전량** fetch (full=81MB / 86s) | **보이는 LOD만** range 9요청 |
| 렌더 | 전체 점(최대 10.65M) PointPrimitiveCollection | LOD 점만 |
| 점↑ 거동 | 느려짐 → 렌더 벽 예상 | 스트리밍, 매끄러움 유지 |

**기준점 결론:** 격차의 정체는 단 하나 — **LOD 스트리밍**. 오픈 피어(deck.gl)도, 닫힌 타깃(Cesium/Eptium)도 전부 LOD로 *보이는 만큼만* 가져온다. 우리 naive는 전량을 가져와 그린다. → **Phase 2가 만들 것 = 이 LOD 스트리밍을 Cesium 위에서.** (그리고 오픈 피어가 또 Cesium이 아님 = 갭 재확인)

← [PROBLEM](PROBLEM.md) · [STRATEGY](STRATEGY.md) · [PROFILING](PROFILING.md)
