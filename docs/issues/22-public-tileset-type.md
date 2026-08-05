# #22 공개 tileset 헬퍼가 타입 선언에서 누락됨

**Issue**: https://github.com/thissak/CopcCesiumLab/issues/22
**Status**: Open
**Created**: 2026-08-06
**Resolved**: -

---

## 1. 문제

### 증상
- README가 안내하는 `tileset.snapPoint()`와 `tileset.attributeRange()`가 생성된 타입 선언의 반환형에 없어 TypeScript 소비자 코드가 컴파일되지 않는다.

### 재현 조건
- `dist/index.d.ts`를 사용하는 클린 TypeScript 소비자 프로젝트에서 README 예제를 타입 검사한다.

### 스크린샷 / 로그
- Step 1에서 RED 컴파일 로그를 추가한다.

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
