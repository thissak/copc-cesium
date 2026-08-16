# #23 CRS 수평·수직 단위 혼용과 비보수적 tile region

**Issue**: #23 (개발 이력 — 비공개 트래커)
**Status**: Resolved
**Created**: 2026-08-06
**Resolved**: 2026-08-06

---

## 1. 문제

### 증상
- 지리좌표계 또는 수평·수직 단위가 다른 COPC에서 LOD geometric error가 잘못 계산될 수 있다.
- 투영 변환의 대각선 두 점만으로 tile region을 계산해 실제 점 범위를 보수적으로 포함하지 못할 수 있다.

### 재현 조건
- EPSG:4326과 수평·수직 단위가 다른 compound CRS 입력의 metric error를 검사한다.
- 비선형 투영에서 사각형 모서리·변의 WGS84 극값이 region에 포함되는지 검사한다.

### 스크린샷 / 로그
- `check:crs` RED 3건:
  - 혼합 단위: 수직 metre 대신 수평 foot 계수 `zUnit=0.3048006096012192`.
  - EPSG:4326 1° extent: root geometric error `0.0625`(도를 미터로 취급).
  - 비선형 변 극값: 실제 north `3.5°` 대신 대각선 north `1°`.

---

## 2. 원인 분석

### 측정 데이터
- 기존 코드는 PROJCS의 마지막 `UNIT`을 `zUnit`과 geometric error에 동시 사용했다.
- region은 source 사각형의 최소·최대 대각선 두 점만 WGS84로 변환했다.

### 근본 원인
- 서로 독립적인 수평 CRS, 수직 CRS, 3D Tiles metric을 하나의 선형 계수로 취급했다.
- 비선형 투영에서 변경 극값이 모서리 대각선에만 있다고 가정했다.

---

## 3. Best Practice 조사

### 조사 항목
- compound CRS의 수평·수직 구성, 3D Tiles geometric error 단위, region 포함 계약.

### 프로덕션 사례
| 프로젝트 | 접근 방식 | 비고 |
|---------|----------|------|
| OGC WKT CRS | compound CRS를 서로 독립적인 수평·수직 CRS로 구성 | https://docs.ogc.org/is/12-063r5/12-063r5.html |
| OGC 3D Tiles 1.0 | geometric error는 미터, bounding volume은 기하 전체를 포함 | https://docs.ogc.org/cs/18-053r2/18-053r2.html |
| Cesium Rectangle | west/east/south/north는 각각 경위도 극값·반자오선 규칙을 따름 | https://cesium.com/learn/cesiumjs/ref-doc/Rectangle.html |

### 엣지 케이스 / 위험 요소
| 시나리오 | 위험도 | 대응 |
|---------|--------|------|
| EPSG:4326 각도 source | 높음 | WGS84 변환 경계의 ECEF chord로 미터 폭 측정 |
| 혼합 수직 단위 | 높음 | `VERT_CS`/`VERTCRS` 단위 독립 해석 |
| 반자오선 통과 | 중간 | 최대 원형 gap의 보여집합으로 longitude interval 산출 |
| 비선형 변 극값 | 중간 | 네 변을 8구간으로 샘플링 |

---

## 4. 수정 내용

### 변경 파일
| 파일 | 변경 요약 |
|------|----------|
| `src/copc-core.ts` | 수직 단위 독립 해석, WGS84 경계 metric 폭 측정 |
| `src/tileset.ts` | metric geometric error, 변 샘플링 region·반자오선 처리 |
| `scripts/check-crs.ts` | 혼합 단위·EPSG:4326·비선형 region RED→GREEN |
| `docs/adr/007-spatial-reference-metric-separation.md` | 공간참조 metric 분리 결정 |

### Before / After
- Before: `cubeSide * zUnit / 16`, 대각선 두 점 region.
- After: 수평 WGS84·수직 미터 최대 `rootSpanM / 16`, 네 변 샘플 region.

### PR
- 미생성.

---

## 5. 검증 결과

### 테스트 방법
- `npm run check:crs`
- `npx tsc --noEmit`
- `npm run check:snap`
- `npm run verify`

### 결과
| 항목 | 수정 전 | 수정 후 | 판정 |
|------|---------|---------|------|
| 혼합 단위 Z | `0.3048006096` | `1` | PASS |
| EPSG:4326 root GE | `0.0625` | `6957.38m` | PASS |
| 비선형 region north | `1°` | `3.5°` | PASS |
| Autzen georef | PASS | PASS | PASS |
| 스냅 회귀 | PASS | PASS | PASS |

### 잔여 이슈
- 사용자 정의 고주파 투영은 유한 경계 샘플링으로 수학적 완전 보증하지 않음. proj4 실용 투영은 부드러운 변환이므로 현재 8구간을 출하 값으로 채택.

### PR #28 Dual Review 보강

- 1차 Blue 리뷰에서 `zUnit` 의미 분리 후 기존 snap metric이 수평 단위 대신 수직 단위를
  계속 사용한 회귀를 확인했다. `horizontalUnit`을 세션 계약에 추가하고 Z 차분 정규화 및
  거리 환산을 분리했다.
- geographic compound WKT 수평 추출과 proj string `+vunits`도 추가했다.
- 혼합단위 픽스처는 3ft 수평 후보와 1m 수직 후보의 올바른 argmin 및 미터 거리를 고정한다.
- 2차 Red·Blue 교차검증에서 geographic degree를 1m로 오인하는 경로를 확인해
  `horizontalIsAngular` 분기와 WGS84 ECEF 스냅 metric을 추가했다. 0.001° 수평 후보보다
  1m 수직 후보를 선택하고 거리를 1m로 반환하는 회귀 계약으로 고정했다.
- 3차 리뷰에서 `EPSG:4326`/`WGS84` 별칭이 문자열 판정을 우회함을 확인해 proj4의 해소된
  `projName` 판정으로 교체하고, 세션 metric 분기 자체를 unit 테스트에 포함했다.
- 4차 리뷰에서 geographic COPC의 정육면체 `info.cube`가 Z 미터 범위만큼 X/Y 도 범위를
  팽창시키는 실제 open 실패를 확인했다. root span은 header bbox로 측정하고 node region은
  header XY로 clamp했다. side 200의 재현 cube와 0.01° 실제 bbox를 회귀 테스트로 고정했다.
- 5차 리뷰에서 cube가 center 기준이 아니라 header.min 기준임을 실데이터로 정정했다.
  sanity guard는 header bbox 중심을 사용하고, root span은 수평/수직 metric 최대값으로 바꿔
  동일 XY·200m 수직 스캔도 GE=12.5m를 유지하도록 고정했다.
- 6차 리뷰에서 ESRI `VERTCS`와 0 bbox의 root GE 폴백 누락을 확인했다. `computeRootSpanM`을
  프로덕션·테스트가 함께 사용하고, 0 bbox는 cube 수직 4656m를 보존하도록 고정했다.
- 7차 리뷰에서 0 bbox가 region을 `(0,0)`으로 붕괴시키는 경로를 확인했다. projected 0 bbox는
  hierarchy cube 위치로 복구하고, geographic 0 bbox는 명시적으로 실패한다. 비유한 Z는 cube Z,
  정상 header region 샘플은 격자 reproject를 사용한다.
- 8~11차 리뷰와 공식 규약 재검토에서 fallback을 축별 계약으로 정리했다. COPC `info.cube`는
  단일 radius 정육면체이므로 projected header에 metric 근거가 전혀 없을 때만
  `side × max(horizontalUnit,zUnit)`을 사용한다. geographic은 mixed-unit cube를 쓰지 않되,
  header XY chord 또는 Z 미터 span 중 사용 가능한 축 하나만 있어도 그 metric을 보존한다.
  13차의 세션 신뢰 정책은 14차 최종 리뷰에서 폐기했다. hierarchy cube와 header Z의 부분 겹침은
  실제 점 포함을 증명하지 못해 `header=[0,100]`, `cube=[0,800]`, `pointZ=700`을 컬링했다.
  OGC 3D Tiles는 bounding volume이 content를 완전히 포함할 것을 요구하고 COPC는 octree의
  center/halfsize를 정의하므로, projected Z는 항상 node cube를 사용한다. geographic만 단일
  halfsize에 각도·미터가 섞여 cube Z를 사용할 수 없으므로 유효 header Z를 유지한다.

### 14차 재현·BP·수정·검증

- **RED:** 부분 겹침 반례의 emitted Z가 `[0,100]`이라 실제 점 Z=700을 포함하지 못했다.
- **BP:** OGC 3D Tiles는 tile bounding volume의 content 완전포함과 child content의 parent
  bounding volume 내부 배치를 요구한다. COPC info VLR은 octree center와 모든 면까지의
  perpendicular halfsize를 정의한다. hierarchy entry는 point count와 chunk 위치만 제공하므로
  cube/header 겹침으로 실제 point extrema를 추론할 근거가 없다.
- **수정:** projected tile Z를 node cube로 단일화하고 `headerZTrusted`, hierarchy 스캔,
  lazy-page 신뢰 역전 예외를 삭제했다. geographic header Z 경로만 유지했다.
- **GREEN:** 동일 반례 emitted Z `[0,800]`; `check:crs` PASS. 전체 unit/build/lib/integration으로
  회귀를 확인한다.
