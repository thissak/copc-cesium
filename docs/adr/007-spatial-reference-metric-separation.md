# ADR-007: 공간참조 단위와 3D Tiles metric 분리

- **상태**: Accepted (2026-08-06)
- **관련**: [ADR-001](001-provider-plugin-architecture-A.md) · [이슈 #23](../issues/23-spatial-reference-units-region.md)

## 맥락

COPC의 수평 CRS는 미터·피트·각도 단위를 쓸 수 있고 compound CRS의 수직 CRS는
수평 CRS와 다른 단위를 가질 수 있다. 반면 3D Tiles `geometricError`는 항상 미터이고,
`region`은 EPSG:4979 공간에서 실제 콘텐츠를 전부 포함해야 한다.

기존 구현은 수평 PROJCS의 `UNIT` 값 하나를 Z 변환과 geometric error 둘 다에
사용했고, tile region은 대각선 두 점만 변환했다. 이 계약은 지리좌표계,
혼합 단위 compound CRS, 비선형 투영에서 성립하지 않는다.

## 결정

1. 수직 단위는 compound CRS의 `VERT_CS`/`VERTCRS` 선형단위에서 독립적으로
   해석하고, 수직 CRS가 없을 때만 수평 선형단위를 사용한다.
2. root 수평 폭은 source 단위를 곱하지 않고, source extent 경계를 WGS84로
   변환한 후 WGS84 ECEF chord 길이로 한 번 측정한다.
3. `geometricError(d) = horizontalSpanM / 16 / 2^d`로 계산해 ept-tools의
   `cube side / 16` 관례를 metric 공간에서 유지한다.
4. tile region은 source 사각형의 네 변을 등간격 샘플링해 비선형 투영의
   변 중간 극값과 반자오선 경계를 보수적으로 포함한다.

## 결과

- **(+)** 지리좌표계와 피트·미터 혼합 compound CRS에서도 높이와 LOD 단위가 정합한다.
- **(+)** 비선형 투영의 tile을 잘못 culling할 위험을 줄인다.
- **(−)** 세션 open 시 root 경계 측정, tileset JSON 생성 시 tile당 고정 샘플링 비용이 추가된다.
- **(−)** 경계 샘플링은 유한 표본이므로 임의의 고주파 사용자 정의 투영을 수학적으로
  완전 보증하지는 않지만, proj4가 지원하는 실용 투영의 부드러운 변형에 비례적인 안전장치다.

## Dual Review 보강 (PR #28)

- 세션은 `horizontalUnit`과 `zUnit`을 별도로 보존한다. 스냅 최근접 비교는 Z 차분을
  `zUnit / horizontalUnit`으로 수평 source 단위계에 정규화하고 최종 거리는
  `horizontalUnit`으로 미터 환산한다. 수평 피트·수직 미터에서도 argmin과 `distanceM`이 등방이다.
- compound CRS의 수평 부분은 projected뿐 아니라 geographic WKT도 추출한다.
- proj string override의 `+vunits`/`+vto_meter`도 수직 단위 계약에 포함한다.
- 2차 리뷰에서 geographic source X/Y가 각도임을 별도 표시하고, 스냅 후보를 WGS84 ECEF
  미터 공간에서 비교하도록 보강했다. projected 경로는 빠른 source metric을 유지한다.
- 3차 리뷰에서 문자열 모양 대신 proj4가 해소한 `Proj.projName`으로 angular 여부를 판정해
  `EPSG:4326`·`WGS84` 별칭도 같은 ECEF 경로를 사용하도록 고정했다. 후보 변환은 기존
  sub-mm 격자 reprojector를 재사용한다.
