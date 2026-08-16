# #25 서비스워커가 clientId 부재 시 임의 탭으로 라우팅함

**Issue**: #25 (개발 이력 — 비공개 트래커)
**Status**: Resolved
**Created**: 2026-08-06
**Resolved**: 2026-08-06

---

## 1. 문제

### 증상
- 요청의 `clientId`를 찾지 못하면 첫 번째 열린 창으로 전달해 다중 탭에서 잘못된 세션으로 라우팅될 수 있다.

### 재현 조건
- 두 클라이언트가 각자 동일한 로컬 sid를 가진 상태에서 `clientId`가 없는 요청의 전달 대상을 검사한다.

### 스크린샷 / 로그
- `check:sw-routing` RED: `status=404 fallbackPosts=1` — `clientId` 없는 요청이 임의 탭에 전달됨.

---

## 2. 원인 분석

### 측정 데이터
- `clients.get('')` 실패 후 `clients.matchAll()[0]`에 메시지 1회 전달, 가상 탭의 빈 노드 응답으로 404 반환.

### 근본 원인
- 요청을 시작한 클라이언트 정체성이 없는데도 열린 창 중 첫 번째를 같은 클라이언트로 가정했다.
- sid가 탭별로 `s1`부터 시작해 잘못된 탭에 동일 sid가 있으면 다른 데이터를 반환할 수 있었다.

---

## 3. Best Practice 조사

### 조사 항목
- FetchEvent 클라이언트 식별 계약과 식별자 부재 의미.

### 프로덕션 사례
| 프로젝트 | 접근 방식 | 비고 |
|---------|----------|------|
| W3C Service Workers | `clientId`는 request client 식별자, initiating client가 없으면 빈 문자열 | https://w3c.github.io/ServiceWorker/ |
| MDN FetchEvent | `clientId`를 `Clients.get()`에 전달해 해당 클라이언트를 조회 | https://developer.mozilla.org/en-US/docs/Web/API/FetchEvent/clientId |

### 엣지 케이스 / 위험 요소
| 시나리오 | 위험도 | 대응 |
|---------|--------|------|
| clientId 빈 문자열 | 높음 | 503 fail-loud, 다른 탭으로 폴백 금지 |
| clientId는 있지만 클라이언트 만료 | 중간 | `clients.get()` 미스를 동일한 503으로 처리 |

---

## 4. 수정 내용

### 변경 파일
| 파일 | 변경 요약 |
|------|----------|
| `public/copc-sw.js` | `matchAll()[0]` 임의 폴백 제거, 요청 client 미가용 시 503 |
| `scripts/check-sw-routing.ts` | SW 가상 실행·다중 클라이언트 라우팅 계약 |
| `package.json` | `check:sw-routing` 진입점 |

### Before / After
- Before: `clients.get(clientId) ?? clients.matchAll()[0]`.
- After: 정확한 `clientId` 클라이언트만 사용, 없으면 503.

### PR
- 미생성.

---

## 5. 검증 결과

### 테스트 방법
- `npm run check:sw-routing`
- `npx tsc --noEmit`
- `npm run build:lib`

### 결과
| 항목 | 수정 전 | 수정 후 | 판정 |
|------|---------|---------|------|
| clientId 부재 HTTP | 404(다른 탭 응답) | 503 | PASS |
| 임의 탭 postMessage | 1회 | 0회 | PASS |
| 라이브러리 빌드 | PASS | PASS | PASS |

### 잔여 이슈
- 없음.

### PR #28 Dual Review 보강

- 부정 경로(clientId 없음→503)뿐 아니라 정상 clientId가 정확한 클라이언트에 1회 전달되고
  empty 응답 404로 이어지는 양성 경로도 VM 회귀 테스트에 추가했다.
- 2차 리뷰 후 `clientId`는 있으나 client가 만료된 경로도 503·postMessage 0회로 고정했다.
