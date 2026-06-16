---
slug: decode-on-main-thread
title: 디코드는 어디서 도는가 — 서비스워커 vs 메인스레드
status: active
last_verified: 2026-06-17
owner: copc-cesium
projects: [CopcCesiumLab]
---

# 디코드는 어디서 도는가

> 서비스워커는 **네트워크만 가로채는 라우터**고, 진짜 점군 디코드(WASM + 좌표변환)는 **페이지 메인스레드**에서 돈다. SW 스레드와 디코드 스레드가 다르다.

## 한 줄

Cesium이 노드를 요청하면 [[service-worker-tile-interception]] 가 fetch를 가로채 페이지로 메시지를 던지고, 페이지가 그 노드만 디코드해 pnts로 돌려준다. 가로채기는 SW 스레드, **디코드는 메인스레드**.

## 왜 메인스레드인가 (의미)

핵심은 **상태가 어디 사는가**다. laz-perf WASM 인스턴스와 열린 COPC 세션(좌표변환기 포함)은 페이지 모듈 스코프에 산다. 서비스워커는 자기 라이프사이클상 언제든 종료될 수 있어 이 무거운 세션 상태를 들고 있기 곤란하다. 그래서 SW는 "가로채서 세션이 사는 페이지로 되던지는" 라우터 역할만 하고, 디코드 실체는 세션이 있는 메인스레드로 돌아온다.

## 비용이 어디로 떨어지나 (약점)

- **좋은 점**: 네트워크 가로채기·라우팅은 SW 스레드라 메인스레드를 막지 않는다.
- **부담**: 점마다 좌표 재투영하는 디코드 루프와 WASM 디코드가 **Cesium 렌더 루프와 같은 메인스레드**에서 돈다. 노드가 크거나 여러 노드가 동시에 들어오면 프레임을 갉아먹는다. 색 계산 루프도 동일.
- 떼어내려면 Web Worker 풀 위임이 자연스러운 후보지만 — 워커 풀은 프로젝트 STOP 규칙 대상(prior art 조사 후 착수). 여기선 "현상" 까지만.

연결: [[service-worker-tile-interception]] · [[copc-octree-lod-streaming]]

## 참고 (RAW 인용)

- 페이지 메시지 핸들러 + 디코드 호출: `src/copc-tileset.ts` (`installHandler`, `nodeToPnts`)
- 노드 디코드 본체(WASM 디코드 + 좌표 재투영 루프): `src/copc-core.ts` (`decodeNode`)
- fetch 가로채기 + MessageChannel 라우팅: `public/copc-sw.js` (`/__copc-real/*`)
- 배경 결정: ADR-002 (서비스워커 타일 가로채기)
