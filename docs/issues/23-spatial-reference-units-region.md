# #23 CRS 수평·수직 단위 혼용과 비보수적 tile region

**Issue**: https://github.com/thissak/CopcCesiumLab/issues/23
**Status**: Open
**Created**: 2026-08-06
**Resolved**: -

---

## 1. 문제

### 증상
- 지리좌표계 또는 수평·수직 단위가 다른 COPC에서 LOD geometric error가 잘못 계산될 수 있다.
- 투영 변환의 대각선 두 점만으로 tile region을 계산해 실제 점 범위를 보수적으로 포함하지 못할 수 있다.

### 재현 조건
- EPSG:4326과 수평·수직 단위가 다른 compound CRS 입력의 metric error를 검사한다.
- 비선형 투영에서 사각형 모서리·변의 WGS84 극값이 region에 포함되는지 검사한다.

### 스크린샷 / 로그
- Step 1에서 RED 측정값을 추가한다.

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
