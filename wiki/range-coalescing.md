---
slug: range-coalescing
title: range coalescing — 인접 노드를 한 번에 읽어 round-trip을 줄인다
status: active
last_verified: 2026-06-18
owner: copc-cesium
projects: [copc-cesium]
---

# range coalescing — 왜 적게 요청하는 게 빠른가

> deep-load가 느린 건 디코드가 느려서가 아니라 **요청을 너무 많이 보내서**다. 클라우드 호스트당 동시연결은 막혀 있고(HTTP/1.1) 매 요청엔 고정 왕복비(TTFB)가 붙는다. 그래서 "더 빨리/더 많이 요청"이 아니라 **인접 노드의 byte range를 연속 1회 GET으로 묶어 round-trip 수 자체를 줄이는 것**이 진짜 레버다. 이게 상용 Eptium이 빠른 이유의 핵심이고, copc.js·PDAL·Potree 어디에도 없던 우리 코어의 차별점이다.

## 한 줄

Cesium이 노드 N개를 요청하면 보통 range GET N번이 나간다. 하지만 COPC에서 **형제·부모-자식 노드의 point-data는 파일 안에서 서로 가깝게 놓인다**. 그 인접성을 이용해, 가까운 range들을 하나의 연속 구간으로 **병합(coalesce)** 해 단일 GET으로 받고, 받은 큰 덩어리를 노드별로 **잘라(slice)** 디코드에 넘긴다. 같은 점을 그리는데 왕복 수만 줄어든다 — [[decode-in-worker]] 의 디코드 경로는 한 줄도 바뀌지 않는다.

## 왜 이게 맞는 레버인가 (의미)

병목을 측정으로 분해하면 deep-load 시간의 거의 전부가 **range fetch의 왕복비**였다(디코드·pnts 빌드는 무시 가능). 그런데 동시성을 올려서 왕복을 겹치게 하는 길은 막혀 있다 — 브라우저는 HTTP/1.1 호스트당 ~6연결로 묶이고, 그 천장을 억지로 넘기면 가짜 동시성과 타임아웃 폭풍만 생긴다([[decode-in-worker]] 의 워커풀 기각·ADR-004 throttle이 같은 천장의 다른 얼굴). 천장이 고정이라면 **천장을 덜 두드리는 것**, 즉 요청 개수를 줄이는 것만이 남는 레버다.

핵심 통찰은 "fetch는 비싸지만 bytes는 싸다"는 클라우드 IO의 비대칭이다. 두 노드가 파일에서 가깝다면, 사이의 쓸모없는 몇 KB까지 같이 읽어 **한 번에** 가져오는 게, 따로 두 번 왕복하는 것보다 싸다. 이건 우리가 발명한 게 아니라 클라우드 최적 포맷을 다루는 모든 스택의 표준이다 — GDAL `/vsicurl`의 range merge, fsspec의 `merge_ranges`, Zarr/kerchunk의 prefetch가 전부 같은 패턴이다. COPC도 정확히 이런 "클라우드 위에서 부분 읽기" 포맷이라 그대로 들어맞는다.

## 두 개의 상한 (two-cap) — 왜 무한정 안 묶나

병합은 공짜가 아니다. 너무 공격적으로 묶으면 **안 쓸 bytes를 너무 많이** 읽고(낭비), 한 덩어리가 너무 커지면 그 큰 GET 하나가 느려져 동시성을 죽인다. 그래서 두 개의 상한을 **동시에** 건다:

- **gap 상한**: 두 range 사이 빈틈이 이보다 크면 묶지 않는다(낭비 bytes 제한).
- **size 상한**: 묶은 덩어리가 이보다 커지면 끊는다(GET 하나가 너무 비대해지지 않게).

둘 중 하나라도 어기면 새 그룹을 시작한다. 이 두 노브가 "왕복 절감"과 "낭비·지연" 사이의 균형점이고, 값 자체는 prior art(`/vsicurl` 등)의 관행을 따랐다.

## 정확성의 함정 — octree 순서 ≠ byte 순서

가장 미묘한 위험: **COPC는 octree 키 순서가 파일 byte 순서와 같다고 보장하지 않는다.** 노드를 키 순서대로 묶으면 실제로는 파일 여기저기 흩어진 구간을 "연속"이라 착각해, 잘라낸 조각이 엉뚱한 노드 데이터가 될 수 있다. 그래서 병합은 반드시 **실제 byte offset으로 정렬한 뒤** 인접성을 판단한다. 검증은 측정으로 못 박았다 — 병합해 받아 자른 노드별 바이트가 per-node로 따로 받은 것과 **byte-identical**(골든파일)이어야만 통과.

## 캐시와 동시 요청 (region 캐시 · in-flight 공유)

병합 덩어리는 노드 하나보다 크다 → 한 번 받은 덩어리를 **region 캐시**(총바이트 상한 LRU)에 들고, 같은 구간을 다시 요청하면 네트워크 없이 슬라이스로 답한다. 또 형제 노드들이 **거의 동시에** 같은 덩어리를 요청하는 게 흔하므로, 같은 병합 구간에 대한 진행 중 GET을 **하나로 공유(in-flight dedup)** 해 중복 왕복을 막는다. 둘 다 "같은 bytes를 두 번 안 읽는다"는 한 원칙의 두 적용이다.

## 비용·주의 (약점)

- **읽기 증폭(read amplification)**: gap 안의 안 쓸 bytes를 같이 읽으므로 전송량은 미세하게 는다. two-cap의 gap 상한이 이걸 bound한다 — 왕복 절감이 낭비보다 압도적으로 크기에 순이득.
- **transient 메모리 상승**: region 캐시(워커 heap)가 덩어리를 들고, 로드가 빨라지며 같은 시점에 더 많은 타일이 몰려 **peak가 일시적으로 오른다**. cap으로 구조적 bound(누수 아님)이고 상용 대비 여전히 낮지만, 빠름과 peak는 맞바꾼 값이다.
- **S3는 멀티-range GET을 안 준다**: 한 요청에 여러 구간을 못 받는다(주면 200+전체 객체). 그래서 병합은 반드시 **클라이언트에서 연속 단일 구간**으로 만들어 보내야 한다 — 흩어진 구간을 한 요청에 담는 길은 없다.
- **geometry 세션엔 미적용**: 페이지(서브페이지 메타) 읽기는 가볍고 패턴이 달라 coalesce를 안 건다. 워커 디코드 세션에만 적용. 노브를 끄면 기존 per-node 동작으로 폴백.

연결: [[coalescing-inflight-race]] · [[decode-in-worker]] · [[hierarchy-subpage-paging]] · [[service-worker-tile-interception]]

## 참고 (RAW 인용)

- 측정(실 S3·실 GPU, millsite msse=8 712k점): round-trip 61→6(10×↓), settle 13.9s→4.8s(2.9×↓, Eptium ~4s 동급), pointsSelected 712,458 불변, 골든파일 5노드 byte-identical, peakHeap 73.6→115MB(워커캐시·bounded·Eptium 138MB 미만).
- getter 데코레이터(point-read 판별·passthrough·in-flight 공유): `src/copc-core.ts` (`createCoalescingGetter`)
- two-cap 병합(offset 정렬 후 gap≤256KB AND size≤8MB): `src/copc-core.ts` (`groupRuns`)
- region 캐시(총바이트 LRU 64MB·oversized 미보관·slice=copy): `src/copc-core.ts` (`createRegionCache`)
- 크기비례 타임아웃: `src/copc-core.ts` (`rangeTimeoutMs`)
- 배선(노브 `coalesceMaxGap`/`coalesceMaxBytes`/`coalesceCacheBytes`, `coalesceMaxGap:0`=off, 데모 `?coalesce=0`): `src/copc-tileset.ts`, `src/decode.worker.ts`, `src/main.ts`
- 골든파일·단위테스트: `scripts/check-coalesce.ts` (`COALESCE_NET=1`로 네트워크 동일성)
- prior art: GDAL `CPL_VSIL_CURL` range merge · fsspec `merge_ranges` · Zarr/kerchunk prefetch (클라우드 부분읽기 표준)
- 배경: [ADR-006](../adr/006-range-coalescing.md)(range coalescing) · ADR-004(메모리·동시성 Cesium 위임 — 같은 동시연결 천장) · 이슈 #02 §6–8
