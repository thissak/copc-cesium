# #22 공개 tileset 헬퍼가 타입 선언에서 누락됨

**Issue**: #22 (개발 이력 — 비공개 트래커)
**Status**: Resolved
**Created**: 2026-08-06
**Resolved**: 2026-08-06

---

## 1. 문제

### 증상
- README가 안내하는 `tileset.snapPoint()`와 `tileset.attributeRange()`가 생성된 타입 선언의 반환형에 없어 TypeScript 소비자 코드가 컴파일되지 않는다.

### 재현 조건
- `dist/index.d.ts`를 사용하는 클린 TypeScript 소비자 프로젝트에서 README 예제를 타입 검사한다.

### 스크린샷 / 로그
- `scripts/check-public-types.ts` RED:
  - `TS2339: Property 'snapPoint' does not exist on type 'Cesium3DTileset'.`
  - `TS2339: Property 'attributeRange' does not exist on type 'Cesium3DTileset'.`

---

## 2. 원인 분석

### 측정 데이터
- 런타임 메서드 2개가 `src/copc-tileset.ts`에 주입되지만 `dist/index.d.ts`의 `fromUrl` 반환형은 `Promise<Cesium3DTileset>`이었다.

### 근본 원인
- 소비자가 알아야 할 공개 헬퍼가 반환 타입 interface에 반영되지 않고 구현의 타입 단언에만 존재했다.

---

## 3. Best Practice 조사

### 조사 항목
- 기존 객체 타입을 보존하면서 런타임에 추가된 멤버를 표현하는 TypeScript 공식 패턴.

### 프로덕션 사례
| 프로젝트 | 접근 방식 | 비고 |
|---------|----------|------|
| TypeScript | intersection type으로 기존 타입의 모든 멤버와 추가 멤버를 하나의 타입으로 결합 | https://www.typescriptlang.org/docs/handbook/unions-and-intersections.html |

### 엣지 케이스 / 위험 요소
| 시나리오 | 위험도 | 대응 |
|---------|--------|------|
| Cesium 기본 멤버 유실 | 높음 | `Cesium3DTileset & {...}` 교차 타입으로 전체 보존 |
| 진단용 메서드까지 공개 | 중간 | 제품 계약인 `snapPoint`·`attributeRange`만 포함 |

---

## 4. 수정 내용

### 변경 파일
| 파일 | 변경 요약 |
|------|----------|
| `src/copc-tileset.ts` | `CopcCesiumTileset` 타입 추가, `fromUrl` 반환형 및 공개 메서드 주입 타입 일치 |
| `src/index.ts` | 공개 타입 export |
| `scripts/check-public-types.ts` | README 소비자 계약 컴파일 테스트 |
| `package.json` | `check:public-types` 진입점 |

### Before / After
- Before: `Promise<Cesium3DTileset>`으로 반환해 헬퍼가 보이지 않음.
- After: `Promise<CopcCesiumTileset>`로 반환해 Cesium 멤버와 두 헬퍼가 모두 노출됨.

### PR
- 미생성.

---

## 5. 검증 결과

### 테스트 방법
- `npm run check:public-types`
- `npx tsc --noEmit`
- `npm run build:lib`
- `dist/index.d.ts` 선언 확인

### 결과
| 항목 | 수정 전 | 수정 후 | 판정 |
|------|---------|---------|------|
| README 헬퍼 타입 검사 | TS2339 2건 | exit 0 | PASS |
| 프로젝트 타입 검사 | PASS | PASS | PASS |
| 라이브러리 선언 빌드 | 헬퍼 누락 | `CopcCesiumTileset`+헬퍼 포함 | PASS |

### 잔여 이슈
- 없음.
