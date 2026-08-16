# #26 하이어라키 서브페이지 동시 요청이 중복 로드됨

**Issue**: #26 (개발 이력 — 비공개 트래커)
**Status**: Resolved
**Created**: 2026-08-06
**Resolved**: 2026-08-06

---

## 1. 문제

### 증상
- 같은 하이어라키 서브페이지를 렌더와 스냅이 동시에 요청하면 진행 중 요청을 공유하지 않아 동일 range를 중복 fetch·병합할 수 있다.

### 재현 조건
- 같은 key에 `loadSubPage()`를 동시에 두 번 호출하고 hierarchy getter 호출 횟수를 측정한다.

### 스크린샷 / 로그
- `check:paging` RED: 동일 key를 `Promise.all`로 호출하면 hierarchy range read가 2회 발생했다.

---

## 2. 원인 분석

`loadSubPage()`는 완료 후에만 `pages[key]`를 삭제했다. 첫 호출이 await 중일 때 두 번째
호출도 같은 pointer를 보고 독립적인 `Copc.loadHierarchyPage()`를 시작했다.

---

## 3. Best Practice 조사

- 프로젝트 내부 ADR-006의 range coalescing과 같은 in-flight 공유 원칙을 적용한다.
- Go의 공식 `x/sync/singleflight`도 동일 key에 대해 한 실행만 진행하고 중복 호출자는
  같은 결과를 기다리는 계약을 제공한다: https://pkg.go.dev/golang.org/x/sync/singleflight
- 완료 결과를 영구 memoize하지 않고 진행 중 Promise만 공유한다. 실패 시 registry에서
  제거하고 page pointer를 보존해 다음 요청이 재시도할 수 있어야 한다.

---

## 4. 수정 내용

- `CopcSession.pageLoads`에 key별 진행 중 Promise를 등록한다.
- 중복 호출은 기존 Promise를 반환하고, 최초 호출만 hierarchy range를 읽고 병합한다.
- 성공 시에만 `pages[key]`를 삭제하며, `finally`에서 성공·실패 모두 in-flight entry를 정리한다.
- `check:paging`이 동시 호출 두 결과와 실제 range read 1회를 함께 검증하도록 확장했다.

---

## 5. 검증 결과

| 검증 | RED | GREEN |
|------|-----|-------|
| 동일 key 동시 range read | 2회 | 1회 |
| 두 호출 결과 | 둘 다 true | 둘 다 true |
| 서브페이지 decode | 23,423 points | 23,423 points |
| `npx tsc --noEmit` | - | PASS |
| `npm run build:lib` | - | PASS |
