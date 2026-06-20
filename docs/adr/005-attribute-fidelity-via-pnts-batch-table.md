# ADR-005: per-point LAS 속성을 pnts batch table 로 Cesium 에 노출 (네이티브 스타일링·피킹)

- **상태**: Accepted (2026-06-18)
- **관련**: [IMPROVEMENTS](../IMPROVEMENTS.md) Tier1 #1 · 설계 스펙 `docs/superpowers/specs/2026-06-18-attribute-fidelity-design.md` · 구현 계획 `docs/superpowers/plans/2026-06-18-attribute-fidelity.md` · CHANGELOG 2026-06-18 · [ADR-001](001-provider-plugin-architecture-A.md)(LOD 위임)

## 맥락

3D Tiles 변환 파이프라인은 per-point LAS 속성(GpsTime·ReturnNumber·ScanAngle·extra-bytes…)과 정밀도를 **소리없이 드롭**한다(예: Cesium ion 타일러는 Intensity+Classification만 보존). 그래서 Cesium 사용자는 포인트클라우드를 *임의 속성으로 동적 스타일링*하거나 *피킹으로 속성 조회*할 수 없다(Cesium staff: dynamic-range styling 미지원). COPC 는 전체 LAS 속성+native 정밀도를 보존하므로, **무변환인 우리만** 이 갭을 구조적으로 닫을 수 있다(커뮤니티 실수요 확인: Eptium 상용 $5k~25k, OSS 대체 전무; giro3d#633 은 COPC 스트리밍에도 extra-bytes 를 0 으로 로드).

선택지: (A) 속성 값을 Cesium 에 노출(클라이언트가 스타일/피킹) vs (B) 워커에서 색으로 굽기만(값 미노출). (A)만 동적 스타일링·피킹을 가능케 한다.

## 결정

1. **선택한 속성 값을 pnts BATCH_TABLE 로 노출**(A안). `attributes` 옵션: `undefined`=큐레이션 기본(Classification·Intensity·ReturnNumber·NumberOfReturns) | `'all'`=extra-bytes 포함 전체 | `string[]` 명시(없는 dim skip+warn). 속성별 타입 인코딩으로 정밀도 보존(Classification=UNSIGNED_BYTE, Intensity=UNSIGNED_SHORT, GpsTime=DOUBLE…; 미지정 dim=FLOAT 폴백).
2. **스타일링·피킹은 Cesium 네이티브에 위임**(손코딩 picking 안 함 — [ADR-001] 위임 철학 연장). `Cesium3DTileStyle` 의 `${Attr}` 표현식이 점당 색·크기 평가, `Cesium3DTileFeature.getProperty()` 가 피킹 조회. **PoC 로 확정**: 피킹이 feature 를 돌려주려면 feature table 에 **BATCH_ID(+BATCH_LENGTH)가 필수**(없으면 plain object).
3. **기존 colorBy 구운 RGB 는 기본색 유지** — style 미지정 시 그대로(회귀 0). `rampStyle(name,range)` + `tileset.attributeRange(name)` 헬퍼로 동적범위 스타일을 거든다.

## 결과

- **(+)** 변환 없이 전체 속성·정밀도를 Cesium 스타일링/피킹에 노출 — OSS 미해결 지점을 *무변환이라 구조적으로* 닫음(우리 영역성). 손코딩 primitive 0, 신규 의존성 0.
- **(+)** Cesium-free 경계 유지(`attributes.ts`·`pnts-quantized.ts`·`copc-core.ts`·`decode.worker.ts` 는 Cesium 미import; `copc-style.ts`만 페이지측).
- **(−) `${COLOR}` 폴백 미작동**: batch table 이 있는 pnts 는 Cesium 의 **Model 경로**(`Model3DTileContent`)로 렌더되는데, 그 경로에서 style 의 `${COLOR}`(원본 RGB)가 undefined → `Color.fromCartesian4(undefined)` 렌더 에러. → catch-all 은 **구체 색**을 써야 한다(README 명시). 원본 RGB 보존이 필요하면 style 을 지정하지 않으면 된다.
- **(−) pnts 크기↑**: 속성 바이트 + BATCH_ID(점당 2~4B). 큐레이션 기본으로 바운드(~5B/점), `'all'`/GpsTime 은 사용자 선택.
- **(−) extra-bytes 정밀 타입은 FLOAT 폴백**: VLR descriptor 기반 타입·scale/offset 정밀 처리는 미구현(검증용 extra-bytes 파일 부재로 YAGNI). 값은 `'all'` + FLOAT 로 노출되나 정수 extra-bytes 는 2^24 초과 시 정밀도 손실 가능.

## 다음

extra-bytes 실파일 확보 시 정밀 타입 처리 검증. 위치 정밀도(uint16 양자화)는 별도 항목.
