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
