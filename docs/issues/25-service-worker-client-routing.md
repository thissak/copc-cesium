# #25 서비스워커가 clientId 부재 시 임의 탭으로 라우팅함

**Issue**: https://github.com/thissak/CopcCesiumLab/issues/25
**Status**: Open
**Created**: 2026-08-06
**Resolved**: -

---

## 1. 문제

### 증상
- 요청의 `clientId`를 찾지 못하면 첫 번째 열린 창으로 전달해 다중 탭에서 잘못된 세션으로 라우팅될 수 있다.

### 재현 조건
- 두 클라이언트가 각자 동일한 로컬 sid를 가진 상태에서 `clientId`가 없는 요청의 전달 대상을 검사한다.

### 스크린샷 / 로그
- Step 1에서 RED 라우팅 결과를 추가한다.

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
