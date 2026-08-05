# #24 요청 제한값이 다중 tileset 생명주기를 따르지 않음

**Issue**: https://github.com/thissak/CopcCesiumLab/issues/24
**Status**: Open
**Created**: 2026-08-06
**Resolved**: -

---

## 1. 문제

### 증상
- `maxRequestsPerServer`가 Cesium 호스트별 전역 맵에 남아 서로 다른 설정의 tileset이 마지막 값으로 서로를 덮어쓴다.
- destroy 후에도 기존 값이 복원되지 않고, `0`을 지정해도 이전 설정을 취소할 수 없다.

### 재현 조건
- 같은 origin에서 다른 제한값을 가진 tileset을 순차·동시 생성하고 파괴하며 `RequestScheduler.requestsByServer`를 관찰한다.

### 스크린샷 / 로그
- Step 1에서 RED 상태 전이 로그를 추가한다.

---

## 2. 원인 분석

Step 1 재현 후 작성.

---

## 3. Best Practice 조사

Step 2 원인 확정 후 작성.

---

## 4. 수정 내용

Step 3 조사 후 작성.

---

## 5. 검증 결과

Step 4 수정 후 작성.
