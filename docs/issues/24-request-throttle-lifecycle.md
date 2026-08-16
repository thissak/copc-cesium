# #24 요청 제한값이 다중 tileset 생명주기를 따르지 않음

**Issue**: #24 (개발 이력 — 비공개 트래커)
**Status**: Resolved
**Created**: 2026-08-06
**Resolved**: 2026-08-06

---

## 1. 문제

### 증상
- `maxRequestsPerServer`가 Cesium 호스트별 전역 맵에 남아 서로 다른 설정의 tileset이 마지막 값으로 서로를 덮어쓴다.
- destroy 후에도 기존 값이 복원되지 않고, `0`을 지정해도 이전 설정을 취소할 수 없다.

### 재현 조건
- 같은 origin에서 다른 제한값을 가진 tileset을 순차·동시 생성하고 파괴하며 `RequestScheduler.requestsByServer`를 관찰한다.

### 스크린샷 / 로그
- `check:request-throttle` RED: `0 escape hatch가 이전 값을 복원하지 않음: 6`.

---

## 2. 원인 분석

### 측정 데이터
- 기존 호스트 override `11` → tileset 설정 `6` → `0` 후에도 `6` 잔류.

### 근본 원인
- 기존 `setContentServerThrottle()`는 Cesium static map에 쓰기만 하고 기존 값·소유 세션·destroy를 기록하지 않았다.
- `0`은 상태 해제가 아니라 단순 no-op이었다.

---

## 3. Best Practice 조사

### 조사 항목
- Cesium 호스트별 override 용도와 전역 기본값 변경 없이 세션 소유권을 관리하는 패턴.

### 프로덕션 사례
| 프로젝트 | 접근 방식 | 비고 |
|---------|----------|------|
| Cesium RequestScheduler | 알려진 서버를 `requestsByServer` 호스트 override로 제어, 1.113부터 기본 18 | https://github.com/CesiumGS/cesium/blob/main/CHANGES.md |

### 엣지 케이스 / 위험 요소
| 시나리오 | 위험도 | 대응 |
|---------|--------|------|
| 다중 tileset의 서로 다른 상한 | 높음 | 활성 소유자 중 최솟값 적용 |
| 기존 앱 override 존재 | 높음 | 첫 소유 시 스냅샷, 마지막 해제 시 복원 |
| 초기화 실패 | 중간 | 기존 `releaseSession` 실패 정리 경로에 소유권 해제 연결 |

---

## 4. 수정 내용

### 변경 파일
| 파일 | 변경 요약 |
|------|----------|
| `src/copc-tileset.ts` | 세션별 acquire/release, 최솟값 적용, 기존 값 복원 |
| `scripts/check-request-throttle.ts` | 0 해제·다중 세션·순차 destroy 계약 |
| `README.md` | 공유 호스트 override 의미와 복원 계약 정정 |
| `package.json` | `check:request-throttle` 진입점 |

### Before / After
- Before: 호스트 맵에 마지막 값을 영구 기록.
- After: sid 소유권과 원래 값을 기록하고 활성 최솟값을 적용·복원.

### PR
- 미생성.

---

## 5. 검증 결과

### 테스트 방법
- `npm run check:request-throttle`
- `npx tsc --noEmit`
- `npm run check:public-types`

### 결과
| 항목 | 수정 전 | 수정 후 | 판정 |
|------|---------|---------|------|
| 0 escape hatch | 6 잔류 | 기존 11 복원 | PASS |
| 다중 세션 6+12 | 마지막 12 | 보수적 6 | PASS |
| 6 세션 destroy | 상태 미관리 | 남은 12 | PASS |
| 마지막 destroy | 잔류 | 기존 11 | PASS |

### 잔여 이슈
- 서로 다른 `copc-cesium` 번들 인스턴스가 한 페이지에 중복 로드되는 비정상 구성은 모듈 간 소유권을 공유하지 못함.
