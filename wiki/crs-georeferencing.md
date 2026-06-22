---
slug: crs-georeferencing
title: CRS georeferencing — 포인트클라우드를 지구 위 제자리에 놓기
status: active
last_verified: 2026-06-22
owner: copc-cesium
projects: [CopcCesiumLab]
---

# CRS georeferencing — 좌표계를 읽어 지구 위에 놓기, 없으면 조용히 틀리지 않기

> 포인트클라우드의 점은 그 자체로는 "어떤 좌표계의 숫자"일 뿐이다. 그 좌표계 정의(WKT)를 읽어 경위도로 바꿔야 Cesium 지구본 위 제자리에 놓인다. WKT가 있으면 zero-config로 그냥 된다. 진짜 문제는 WKT가 없거나 깨졌을 때 — 그때 점들을 조용히 엉뚱한 곳(지구 밖·거울상)에 던지는 대신 명확히 실패시키고, 사용자가 좌표계를 직접 줄 수 있게 하는 것이 핵심이다. 이건 우리 고유 강점이 아니라 모든 성숙한 도구(py3dtiles·PDAL·giro3d)가 합의한 견고성의 기본이다.

## 한 줄

COPC 헤더의 WKT(좌표계 정의)를 읽어 projected X/Y를 WGS84 경위도로 reproject하고, 그 경위도를 ECEF로 올려 Cesium에 배치한다 — [[decode-in-worker]] 의 디코드 경로가 모든 점에 이 변환을 거친다(점별 proj4가 비싸 데이터셋당 1회 격자 + bilinear로 근사한다 — 아래 '변환 비용'). WKT가 없거나 못 읽으면 좌표를 그대로 통과시키지(=지구 밖) 않고 **명확히 throw**하며, 사용자는 `crs`(강제)·`defaultCrs`(없을 때만) 옵션으로 좌표계를 직접 지정한다.

## 왜 좌표계가 갈림길인가 (의미)

투영좌표계의 X/Y는 미터 단위 평면 좌표다. 이걸 지구(타원체) 위 경위도로 되돌리려면 좌표계 정의가 필요하고, 그 정의의 네 부분이 각각 다른 방식으로 틀어진다: 투영식이 틀리면 위치 전체가, datum이 틀리면 수 m가, 선형단위(미터↔피트)가 틀리면 높이가, 축 순서(Easting/Northing)가 틀리면 거울상이 된다. 그래서 좌표계는 "있으면 좋고 없으면 마는" 부가정보가 아니라, 틀리면 데이터가 통째로 엉뚱해지는 갈림길이다.

happy path는 의외로 견고하다 — 변환 엔진(proj4)이 WKT를 받아 변환함수를 만들고, 좌표계 표기의 신·구 표준(WKT1/WKT2)을 모두 처리한다. 그래서 "WKT 있는 projected COPC"는 추가 설정 없이 그냥 된다. 진짜 구멍은 happy path 밖에 있다.

## 진짜 갭 — WKT가 없을 때

우리 COPC 파서가 읽어주는 좌표계는 WKT **하나뿐**이다. 그런데 좌표계를 WKT가 아니라 GeoTIFF GeoKey(숫자 코드)로만 담은 파일이 존재한다(오래된 LAS 1.2~1.3 계열). 그런 파일은 파서에서 좌표계가 "없음"으로 와서, 변환 없이 X/Y를 경위도로 착각하면 점들이 적도·본초자오선 근처 바다에 떨어진다 — 그것도 **아무 에러 없이**. 이게 업계에서 가장 흔하고 가장 헷갈리는 georeferencing footgun이다. 이번 작업이 막은 게 정확히 이 "조용한 지구 밖"이다.

## 왜 fail-loud + override인가 (업계 합의)

이 갭을 메우는 길은 둘이다: (a) 좌표계를 추측해 기본값을 넣거나, (b) "모른다"고 명확히 실패하고 사용자가 알려주게 하거나. 성숙한 도구는 예외 없이 (b)다 — 기본값 추측은 데이터를 조용히 엉뚱한 곳에 놓는 최악이기 때문이다. 대신 두 가지 override를 표준으로 둔다: 헤더를 **무시하고 강제**하는 모드와, 헤더에 없을 때만 **채우는** 모드. 이 둘은 반드시 구분돼야 한다 — 전자는 "헤더가 틀렸다", 후자는 "헤더가 비었다"는 다른 상황이고, 하나로 뭉뚱그리면 둘 중 하나는 footgun이 된다.

여기에 가드를 하나 더 건다 — 변환을 만든 직후 데이터 중심을 한 번만 변환해보고, 결과가 유효 경위도 범위를 벗어나면 거기서 막는다. 좌표계가 그럴듯하게 파싱됐어도 축이 뒤집혔거나(거울상) 엉뚱한 좌표계면 중심이 범위 밖으로 튀므로, 점 수억 개를 변환하기 전에 싸게 잡아낸다.

## 변환 비용 — 점별 proj4가 내부 계산의 절반이었다 (격자로 근사)

happy path는 정확성에선 견고하지만, 성능에선 좌표변환이 비쌌다 — 측정해 보니 reproject가 **내부 계산(IO 제외)의 절반**을 먹었다(디코드보다 컸다). 원인은 JS 오버헤드가 아니라 점마다 도는 proj4 투영 수학 자체(투영 역변환 + 데이텀 변환)다 — 배열 재사용 같은 미세최적화로는 안 잡혔다. COPC는 유한한 영역을 담고 conformal 투영은 소영역에선 거의 선형이므로, 데이터셋 bounds 위에 듬성한 proj4 control 격자를 **딱 한 번** 깔고 점마다는 그 격자에서 bilinear로 보간하면 점당 proj4 호출이 사라져 수십 배 빨라진다. 근사가 위험한 영역(대륙급 extent·비정상 CRS)은 격자를 만들 때 셀당 여러 점에서 proj4 대비 실제 오차를 재고, 임계(sub-mm)를 넘으면 격자를 촘촘히 하거나 proj4 점별 변환으로 폴백한다 — 정확성은 근사로 타협하지 않고, 근사가 안전할 때만 켠다. 이 격자 근사의 원리(앵커 vs 점·왜 싼가=amortization·오차 모델)는 [[reproject-grid-approximation]] 에 따로 정리했다. 측정·진단 한 사이클은 learn/08·이슈 #17.

## 약점·경계 (안 하는 것)

- **GeoTIFF GeoKey 자동복구를 안 한다.** WKT 없는 파일의 좌표계를 바이너리 파싱해 살려내는 건 별도 복잡도(코드 테이블 번들)라 미룬다. COPC는 LAS 1.4 기반이라 WKT가 표준이고, 드문 GeoTIFF-only 파일은 `crs` override 한 줄로 우회된다. 실데이터에서 빈발이 측정되면 그때 연다.
- **EPSG 코드 override는 흔한 것(UTM·WGS84·WebMercator)만** 내장으로 풀린다. 그 외 EPSG는 proj4 string이나 WKT로 줘야 한다.
- **수직 datum(geoid)을 보정하지 않는다.** 높이는 타원체고(ellipsoidal)로 취급한다 — 모든 web-viewer의 norm이고, 정사고(orthometric) 입력은 수십 m 수직 오프셋이 생길 수 있다.

연결: [[reproject-grid-approximation]](reproject를 싸게 만드는 격자 근사) · [[decode-in-worker]](reproject가 도는 디코드 경로) · [[range-coalescing]](같은 source 계층의 IO 레버)

## 참고 (RAW 인용)

- 해소·가드: `src/copc-core.ts` — `resolveCrs`(우선순위 `crs`>wkt>`defaultCrs` + proj4 생성 try/catch), `checkCenterInRange`(cube 중심 lon∈[-180,180]·lat∈[-90,90]·NaN), `extractHorizontalCrs`(WKT1 COMPD_CS/PROJCS 슬라이스 + 선형단위).
- 변환 비용 격자화(#17): `src/copc-core.ts` — `makeGridReprojector`/`GridReproj`(데이터셋 bounds 위 (G+1)² proj4 격자 + 점별 bilinear, 셀당 다점 오차 가드 <1mm·G 자동 상향, 미달 시 proj4 점별 폴백). 측정·진단: 이슈 #17 · `docs/learn/08-profiling-and-bottleneck-hunting.md`.
- 배선: `crs`/`defaultCrs` 옵션 → `fromUrl` → 페이지·워커 세션 (`src/copc-tileset.ts`, `src/decode.worker.ts`).
- ECEF 배치: 경위도→ECEF는 `Cartesian3.fromDegrees` 동일 공식 + RTC_CENTER (`src/pnts-quantized.ts` `geodeticToEcef`).
- 실측(2026-06-19 BP): proj4 2.20.9가 WKT1·WKT2(PROJCRS/GEOGCRS/BOUNDCRS) 파싱(issue #370 실질 해결) · copc.js 0.0.8은 `.wkt`(VLR 2112)만 노출, GeoTIFF GeoKeyDirectory(34735) 미파싱.
- 단위테스트: `scripts/check-crs.ts` (no-CRS throw·force override·fill-if-missing·garbage throw·center 범위밖/NaN throw — 10/10).
- BP(prior art): py3dtiles `SrsInMissingException`(fail-loud)·`pyproj_always_xy`(축순서) · PDAL `default_srs`(fill) vs `override_srs`(force) 2-mode · giro3d `CoordinateSystem.unknown` · Cesium `Cartesian3.fromDegrees`(lon-first).
- 배경: IMPROVEMENTS Tier1 #2 · spec/plan `docs/superpowers/{specs,plans}/2026-06-19-crs-auto-placement*` · CHANGELOG 2026-06-19.
