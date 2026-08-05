# #26 하이어라키 서브페이지 동시 요청이 중복 로드됨

**Issue**: https://github.com/thissak/CopcCesiumLab/issues/26
**Status**: Open
**Created**: 2026-08-06
**Resolved**: -

---

## 1. 문제

### 증상
- 같은 하이어라키 서브페이지를 렌더와 스냅이 동시에 요청하면 진행 중 요청을 공유하지 않아 동일 range를 중복 fetch·병합할 수 있다.

### 재현 조건
- 같은 key에 `loadSubPage()`를 동시에 두 번 호출하고 hierarchy getter 호출 횟수를 측정한다.

### 스크린샷 / 로그
- Step 1에서 RED 호출 횟수를 추가한다.

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
