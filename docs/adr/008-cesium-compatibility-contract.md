# ADR-008: Cesium 최소 버전은 private codec 계약으로 결정한다

- **상태**: Accepted (2026-08-06)
- **근거**: 이슈 #03 빈 타일 고착, npm 배포본 1.120/1.130/1.135/1.140/1.141/1.142 소스 대조, 이슈 #27

## 맥락

빈 COPC 노드는 404와 `Cesium3DTileset._runtimeContentCodec.missingTilePolicy`를 조합해
ready 상태의 empty tile로 전환한다. 이 필드는 private API라 SemVer만으로 존재를 보장할 수 없다.
기존 peer 범위 `>=1.120`은 실제로 해당 경로가 없는 버전을 정상 호환으로 광고했다.

## 결정

- npm 배포본 대조에서 constructor·missing policy 경로가 함께 확인된 최초 버전 1.142를 peer 최소값으로 둔다.
- `check:cesium-codec`이 설치된 Cesium 소스 계약과 프로젝트 peer 최소값을 함께 검사한다.
- 이 검사와 공개 타입·요청 생명주기·SW 라우팅 검사를 오프라인 `npm test` 및 CI에 포함한다.
- CI는 개별 verify 두 개 대신 전체 integration 스위트를 실행해 새 검사가 자동으로 출하 게이트에 들어오게 한다.

## 결과

- 1.120~1.141 소비자는 설치 단계에서 비호환을 알 수 있고 빈 타일 고착을 조용히 겪지 않는다.
- 향후 Cesium이 private codec을 바꾸면 오프라인 계약 검사가 즉시 실패한다. 실제 GPU의 상태 전이는
  `scripts/bench/repro-03.ts`가 보완한다.
- private API 결합 자체는 남지만 지원 범위와 자동 검출이 일치한다.
