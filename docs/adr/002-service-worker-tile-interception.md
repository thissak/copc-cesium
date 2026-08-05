# ADR-002: 서비스워커 타일 가로채기 + 페이지 디코드 라우팅

- **상태**: Accepted (2026-06-16)
- **관계**: [ADR-001](001-provider-plugin-architecture-A.md)의 "동적 content 공급 다리" 미정 부분을 확정.

## 맥락

ADR-001은 A안(COPC 옥트리를 동적 `Cesium3DTileset`으로)을 택했으나 **"노드 content를 런타임에 어떻게 공급하나"** 는 열어뒀다. 스파이크로 판명([RESULTS](../RESULTS.md)):

- Cesium3DTileset은 content를 **URL fetch 전제**, 런타임 생성 content용 공개 훅 없음.
- Cesium은 타일 content를 **XHR로 요청** (spike2 진단) → `window.fetch` 패치로는 못 잡음.
- copc.js/laz-perf를 서비스워커에 번들하는 건 Vite 마찰이 큼.

## 결정

**서비스워커가 타일 XHR을 네트워크 계층에서 가로채, 디코드는 페이지로 라우팅한다.**

1. tileset content URI = `/__copc-real/{sid}/{key}.pnts` (sid=세션, key=`D-X-Y-Z`).
2. **서비스워커**(`public/copc-sw.js`)가 이 요청을 `fetch` 이벤트로 가로챔 (XHR·fetch 모두 잡힘).
3. SW가 **MessageChannel**로 페이지에 `{key, path}` 전달 → **페이지의 copc.js**가 해당 노드만 range fetch + 디코드 + pnts 생성 → 포트로 응답 → SW가 Response 로 반환.
4. 디코드는 **현재 페이지 메인스레드**. 추후 Web Worker로 이동(③).
5. 다중 tileset은 **sid** 로 세션 라우팅 (`src/copc-tileset.ts`).

## 결과

- **(+)** Cesium XHR/fetch 모두 가로챔. copc.js는 작동 검증된 페이지에 그대로 둠(SW 번들 불필요). sid 라우팅으로 다중 tileset 지원.
- **(−/주의)**
  - 디코드가 메인스레드 → 대용량 시 UI 끊김 위험 → **③에서 Web Worker로 이동 필요.**
  - SW↔페이지 MessageChannel 왕복 비용.
  - **stale SW 제어권 race** — 이전 SW가 제어 중이면 새 코드가 안 먹음 → `register` 전 `getRegistrations().unregister()` 또는 `reg.update()` + `controllerchange` 대기 필요.
- 검증: `?spike4`(단일 노드), `?spike5`(옥트리 트리), 기본 데모(`CopcTileset.fromUrl`).

## 보강 (2026-08-06): 클라이언트 정체성

SW→페이지 라우팅은 `FetchEvent.clientId`가 가리키는 요청 시작 클라이언트에만 보낸다.
`clientId`가 없거나 해당 클라이언트가 만료됐을 때 `clients.matchAll()[0]`으로 다른 탭을
선택하는 폴백은 금지하고 503으로 명확히 실패한다. 탭별 sid가 충돌할 수 있어
임의 탭 선택은 다른 COPC 콘텐츠를 반환하는 정합성 결함이기 때문이다. ([이슈 #25](../issues/25-service-worker-client-routing.md))
