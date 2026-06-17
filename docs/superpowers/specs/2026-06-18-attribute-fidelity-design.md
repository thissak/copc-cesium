# 설계 스펙 — #1 속성·해상도 충실도 (attribute fidelity)

> 출처: [IMPROVEMENTS](../../IMPROVEMENTS.md) Tier1 #1. 브레인스토밍 → PoC 확정 → 본 스펙 → writing-plans.
> 날짜: 2026-06-18. 평가축: 실해·복잡도·우리-영역성·입상 레버리지.

## 1. 문제

3D Tiles 변환 파이프라인은 per-point LAS 속성(GPS-time·return·scan angle·extra-bytes)과 정밀도를 **소리없이 드롭**한다(Ion 타일러는 Intensity+Classification만 살림). 그래서 Cesium에서 점군을 **임의 속성으로 동적 스타일링하거나 피킹으로 속성 조회**할 수 없다 — Cesium staff 확인: *"dynamic range styling은 3D Tiles 스타일 언어 확장 필요, 미지원"*. COPC는 전체 LAS 속성+native 정밀도를 보존하므로 **무변환인 우리만 구조적으로** 이 갭을 닫는다. (OSS 미해결: COPC를 스트리밍하는 giro3d조차 extra-bytes를 0으로 로드 — #633 open.)

현재 우리 코드는 `decodeNode`가 한 차원만 읽어 `colors.ts`가 RGB로 **굽고 값은 버린다**. pnts batch table은 비어 있어(`batchTableJSONByteLength=0`) **속성 값이 Cesium에 안 닿는다.**

## 2. PoC 확정 (2026-06-18, `?spikeBatch`)

합성 점군 + per-point BATCH_TABLE(Classification)로 가설 3개 확정:
- **H1 동적 스타일링 ✅**: `Cesium3DTileStyle({ color: conditions[`${Classification}`...], pointSize: ... })`가 점당 색·크기 override(좌반 노랑 class2 / 우반 빨강 class6, 화면 확인).
- **H2 피킹 ✅**: `scene.pick` → `Cesium3DTileFeature.getProperty('Classification')` 정확. **단 feature table에 `BATCH_ID`(점당 고유 인덱스)+`BATCH_LENGTH` 필수** — 없으면 plain object·getProperty 없음(+2B/점 비용).
- **H3 pnts 유효 ✅**: Cesium이 batch-table pnts 거부 없이 로드(tileFailed 0).

## 3. 목표 / 비목표

**목표**: opt-in으로 선택한 LAS 속성 값을 pnts BATCH_TABLE(+ BATCH_ID)로 Cesium에 노출 → 클라이언트가 **동적 스타일링·피킹 조회**. 동적범위 램프 스타일 헬퍼 제공. 기존 colorBy 구운 RGB는 기본색 유지.

**비목표**(별도): 위치 정밀도(uint16 양자화) 개선 — #1은 *속성 값* 충실도에 집중. CRS 자동배치(#2)·옥트리 피킹(#3)은 별 항목.

## 4. 아키텍처 / 데이터 흐름

```
fromUrl(url, { attributes })
  → worker.open(sid, url, { colorBy, hideClassifications, attributes })
      → resolveAttributes(session, attributes): undefined=큐레이션 | 'all'=extra-bytes포함 | string[]
        → AttributeSpec[] (미존재/오타 skip+warn)
  → decode(sid, key)
      → decodeNode: position + colorBy차원(기본RGB) + AttributeSpec 차원들(typed)
      → buildPnts: POSITION_QUANTIZED + RGB + BATCH_ID(점당 인덱스) + BATCH_TABLE(속성, 타입별)
  → Cesium: tileset.style = Cesium3DTileStyle({…${Attr}…})   ← 동적 스타일
            scene.pick → Cesium3DTileFeature.getProperty('Attr')  ← 피킹
```

## 5. 컴포넌트 (작게·경계 명확)

1. **`src/attributes.ts` (신규)** — `resolveAttributes(session, req): AttributeSpec[]`. LAS dim명 → `{batchName, componentType(UNSIGNED_BYTE/SHORT/…), type, read(view,i)}` 매핑 + extra-bytes VLR 파싱(scale/offset 적용). 단독 테스트.
2. **`decodeNode` 확장** (`copc-core.ts`) — AttributeSpec 차원들을 typed array로 읽어 `{lonLatH, colors, attrs: Map<name, TypedArray>}` 반환.
3. **pnts batch table writer** (`pnts-quantized.ts` 확장 또는 분리) — 현재 0인 batchTable 필드 채움: BATCH_ID(UNSIGNED_SHORT/UNSIGNED_INT, 점수에 따라) + BATCH_LENGTH(FT) + BATCH_TABLE JSON/binary(속성별 8B 정렬). 직렬화만.
4. **`src/copc-style.ts` (신규) — 동적범위 헬퍼** — `rampStyle(attrName, [min,max], palette?): Cesium3DTileStyle`(Cesium-import 페이지측). + 라이브러리가 root 노드 샘플로 `tileset.attributeRange(name): [min,max]` 제공.

## 6. 핵심 결정

- **큐레이션 기본(lean)** = `Classification·Intensity·ReturnNumber·NumberOfReturns`(흔히 스타일·경량, ~5B/점). **GpsTime(8B)·ScanAngle·PointSourceId·UserData·extra-bytes = opt-in**(`'all'` 또는 명시). pnts 크기 산식 문서화.
- **BATCH_ID 항상 포함**(속성 노출 시) — 피킹 활성. 점수>65535면 UNSIGNED_INT. +2~4B/점.
- **속성별 타입 인코딩으로 정밀도 보존** — Classification=UNSIGNED_BYTE, Intensity=UNSIGNED_SHORT, GpsTime=DOUBLE, extra-bytes=VLR descriptor 타입+scale/offset(giro3d#633의 "=0" 갭 정조준).
- **기존 colorBy 구운 RGB = 기본색 유지** — style 미지정 시 그대로. 회귀 0.
- **명명 = Cesium 관례**(`${Classification}` 등, TimeDynamicPointCloud 예제 일치).

## 7. 에러 처리 (조용한 실패 없이·graceful)

- 미존재/오타 속성명 → skip + `console.warn`(throw 아님 — 타일셋 유지). extra-bytes VLR 파싱 실패 → 그 차원만 skip+warn. [[no-silent-failures]] 와 정합(렌더 유지하되 표면화).

## 8. Acceptance Criteria (이진)

1. `attributes`가 `undefined`(큐레이션)·`'all'`·`string[]` 수용; 확정 dim 리스트 로깅; 미존재명 skip+warn.
2. pnts BATCH_TABLE 비어있지 않음 — 기본 4속성 present + componentType 정확 + 값이 copc.js raw와 샘플 점들에서 **정확 일치**.
3. feature table에 BATCH_ID + BATCH_LENGTH present(피킹 활성).
4. `'all'`이 extra-bytes 차원 포함(extra-bytes 파일에서 검증; 없으면 VLR 파서 단위테스트로 대체 — *데이터 가용성 갭 명시*).
5. Cesium 동적 스타일: `${Attr}` color/show/pointSize가 점당 평가(baseline 대비 렌더 변화) — PoC로 메커니즘 확정, 본 구현서 실 COPC로 재확인.
6. 피킹: `scene.pick` → `Cesium3DTileFeature.getProperty('Classification')`이 그 점 값 반환 — PoC 확정, 실 COPC로 재확인.
7. `rampStyle(name,[min,max])` 램프 style 생성 + `attributeRange(name)` root 샘플 범위 제공.
8. 회귀 0: 기본 경로(옵션 없음) 렌더 + `verify` C1 PASS + 기존 colorBy 5모드 불변 + build·build:lib PASS.

## 9. 테스트 시나리오

- **정상**: autzen 기본 → batch table 4속성·값 일치 / style·pick 동작(`scripts/check-attributes.ts` 헤드리스 + 브라우저 style/pick).
- **엣지**: `attributes:['nonexistent']` → skip+warn, 타일셋 로드 유지.
- **엣지**: RGB 없는 millsite + colorBy 'rgb' → height 폴백 불변 + 속성 노출.
- **실패**: extra-bytes VLR 손상 → 그 차원만 skip+warn, 나머지 정상.

## 10. 알려진 갭 (정직)

- **extra-bytes 검증 파일**: autzen/millsite/sofi에 extra-bytes 없을 가능성 → AC#4는 VLR 파서 단위테스트로 보강(실파일 확보 시 통합검증).
- **위치 정밀도**(양자화)는 #1 스코프 외.
- **pnts 크기 증가**: 속성+BATCH_ID로 점당 바이트↑ — 큐레이션 기본으로 바운드, `'all'`은 client 선택.

## 11. PoC 산출물 처리

`src/spike-batch.ts` + main.ts `?spikeBatch` 브랜치 = throwaway PoC. 본 구현 시작 시: (a) `?spikeBatch` 데모로 유지(다른 ?spike처럼) 또는 (b) 제거. 구현 PR에서 결정.
