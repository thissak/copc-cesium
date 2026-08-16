---
slug: coalescing-inflight-race
title: 진행 중 묶음은 "받아온 범위"로 잘라야 한다 — coalescing in-flight/rebuild 레이스
status: active
last_verified: 2026-06-18
owner: copc-cesium
projects: [copc-cesium]
---

# 진행 중 묶음은 "받아온 범위"로 잘라야 한다

> 한 줄: [[range-coalescing]]은 "여러 노드를 한 묶음으로 받아 노드별로 잘라 쓴다". 그런데 묶음의 **경계는 도중에 커질 수 있다**. 진행 중인(in-flight) 묶음을 자를 땐 *지금 계산한 경계*가 아니라 *실제로 받아온 범위*로 잘라야 한다 — 안 그러면 빈 바이트를 디코더에 먹여 메모리가 폭발한다.

## 한 줄

coalescing 은 인접 노드의 byte range 를 하나의 큰 묶음(run)으로 받아 노드별로 슬라이스한다. 그런데 [[hierarchy-subpage-paging|서브페이지가 lazy 로드]]되며 노드 집합이 바뀌면 run 경계가 다시 계산되고, **시작은 같은데 끝만 더 커진** 묶음이 생긴다. 먼저 시작된(작은) 묶음의 fetch 가 끝나기 전에 그 키를 재사용하면, 나중 노드가 **옛 작은 묶음**을 받아 **새 큰 경계로** 잘라 — 범위를 넘어 **빈 바이트**가 나온다. 그 빈 바이트가 [[decode-in-worker|워커의 laz-perf]]에 들어가면 쓰레기 청크 헤더를 읽고 거대 메모리를 잡아 뻗는다(증상은 "디코더 메모리 폭발", 원인은 "잘린 슬라이스").

## 왜 — 정체성을 무엇으로 잡느냐 (의미)

이건 "in-flight 중복제거(single-flight)"의 고전 함정이다. 진행 중 요청을 하나로 합칠 때, 합치는 **키는 결과를 유일하게 식별**해야 한다 — 즉 *실제로 받아온 바이트 범위*라는 불변의 정체성. 우리는 키를 묶음의 **시작 오프셋만**으로 잡았는데, "시작 같고 끝만 커진" 경우 옛 묶음과 새 묶음이 같은 키를 공유해, 나중 요청이 옛(작은) 결과를 받는다. 핵심 교훈: **묶음의 정체성은 받아온 순간 고정된다 — 나중에 바뀐 그룹핑이 "어떻게 자를지"를 정하게 두면 안 된다.**

## 두 경로, 한 규칙

흥미롭게도 **캐시 조회** 경로는 처음부터 옳았다 — 저장된 묶음 *자신의* 범위로 "이게 내 조각을 덮나?"를 확인하고, 그 범위를 기준으로 잘랐다. 버그는 **진행 중(in-flight)** 경로만 *바깥에서 계산한 그룹핑*으로 잘랐던 것이다. 고치고 나니 두 경로가 같은 규칙이 됐다 — **받아온 것의 실제 범위로만 자르고, 그게 내 조각을 못 덮으면 그 조각만 직접 다시 받는다**(coalescing 을 못 하면 속도보다 정확성을 택한다). 한 규칙을 두 곳에서 똑같이 쓰는 게, 같은 일을 두 방식으로 하다 한쪽만 틀리는 것보다 안전하다.

## 왜 늦게 드러났나 (약점)

가벼운 화면에선 묶음 경계가 바뀔 일이 드물어 안 걸렸다. 순차적이고 노드 수가 고정된 단위 골든파일도 못 잡았다 — 그래서 이 결함이 묻힌 채 배포됐다. **무거운 데이터를 깊게** 띄워 서브페이지가 계속 로드되며 그룹핑이 자주 재계산될 때만 레이스 창이 열렸다. 동시성 버그는 "충분히 무거운 부하 + 진행-중-재계산"이 겹쳐야 보인다 — 그래서 *무거운 예제로 측정*하는 것이 결정적이었다. 또 하나: 증상(메모리 폭발)이 원인(잘린 슬라이스)에서 멀어 처음엔 "디코더의 메모리 한계"로 **오진**했다. 증상에서 멈추지 않고 측정으로 원인까지 따라가야 한다.

연결: [[range-coalescing]] · [[decode-in-worker]] · [[hierarchy-subpage-paging]]

## 참고 (RAW 인용)

- 버그/수정 위치: `src/copc-core.ts` (`createCoalescingGetter`). 수정 = in-flight promise 가 `Uint8Array` 대신 `{start,end,bytes}`(fetch 한 실제 정체성)를 resolve → 슬라이스 전 커버리지(`region.start<=begin && region.end>=end`) 검사 → 미달 시 `base(begin,end)` 직접 폴백. cache 경로(`createRegionCache.lookup`)는 원래부터 region 자신의 start/end 로 검사·슬라이스(그래서 옳았다).
- 트리거: `inflight` 가 `run.start` 만으로 dedup + 노드 수 변화 시 `rebuild` 가 run 경계 재계산("같은 start, 더 큰 end").
- 회귀 가드: `scripts/check-coalesce.ts` Task 7(결정적 단위 — 첫 fetch 를 hang 시킨 채 인접 노드 추가로 run 확장) + `scripts/bench/repro-04.ts`(브라우저 — 워커 laz-perf heap 궤적·슬라이스 범위초과 카운트).
- 측정(sofi 1.9GB, msse=4, coalesce ON): heap 7→1877MB 단일 점프(범인 node 4-4-4-1, 단 21,743점) → WASM 2GB abort + 타일 500. 수정 후 heap 7.1MB 고정·완주(=coalesce OFF 동일). OFF 는 항상 정상.
- BP: Apache Arrow `ReadRangeCache`(`lower_bound`→`Contains()`→`SliceBuffer`, fetched range 기준) · Go `singleflight`(키=결과 정체성) · fsspec `merge_offset_ranges`(grouping 1회 스냅샷).
- 배경: 이슈 `docs/issues/04-lazperf-wasm-2gb-ceiling.md` · 기능/결정 [ADR-006](../adr/006-range-coalescing.md) · 진단 흐름 이슈 #02.
