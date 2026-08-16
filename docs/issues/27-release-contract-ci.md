# #27 출하 계약 테스트와 Cesium 최소 호환 버전이 불일치함

**Issue**: #27 (개발 이력 — 비공개 트래커)
**Status**: Resolved
**Created**: 2026-08-06
**Resolved**: 2026-08-06

---

## 1. 문제

- 새 결정적 회귀 검사가 기본 `npm test`와 CI에서 실행되지 않는다.
- 빈 타일 처리의 private codec은 Cesium 1.142부터 존재하지만 peer 범위는 1.120부터 허용한다.

## 2. 재현

- `check:cesium-codec`으로 설치 소스의 codec 계약과 선언된 peer 최소 버전을 함께 검사한다.
- `scripts/run-checks.ts`와 `.github/workflows/ci.yml`에서 누락된 진입점을 확인한다.

## 3. Best Practice 조사

- npm의 Cesium 1.120·1.130·1.135·1.140·1.141·1.142 배포본을 직접 풀어 source contract를 대조했다.
- `_runtimeContentCodec`와 `missingTilePolicy` 경로는 1.142에서 처음 함께 확인됐다.
- private API는 SemVer 보장이 없으므로 설치 소스 계약을 CI에서 직접 검사하고 peer 최소값도 같은 검사에서 고정한다.

## 4. 수정 내용

- peer dependency를 `>=1.142.0`으로 올리고 README·기존 이슈 문서를 동기화했다.
- `check:cesium-codec`을 추가해 constructor, missing policy, peer 최소값을 검사한다.
- public type·request throttle·SW routing·codec 검사를 unit runner에 연결해 5개에서 9개로 확대했다.
- CI가 unit 9개와 integration 9개를 모두 실행하도록 바꿨다.

## 5. 검증 결과

| 검증 | 결과 |
|------|------|
| codec RED (`peer >=1.120`) | FAIL (`peerContract=false`) |
| codec GREEN (`peer >=1.142`) | PASS |
| `npm test` | 9/9 PASS |
| `npm run test:integration` | 9/9 PASS |
| `npm run build` / `build:lib` | PASS / PASS |
| `mkdocs build --strict` | PASS |
| `npm pack --dry-run` | PASS (8 files) |
