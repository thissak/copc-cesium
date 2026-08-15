# CRS 자동배치 견고화 (Tier1 #2) — 설계 spec

> 작성 2026-06-19 · 출처: IMPROVEMENTS #2 · BP 조사(proj4/copc.js 실측 + prior-art 6종) · 승인 scope = **A안**
> 결정 근거는 구현 후 ADR-007로 승격. 진행은 [PROGRESS](../../PROGRESS.md).

## 1. 문제 (측정으로 확정)

현 georef(`src/copc-core.ts`)는 `copc.wkt`(LAS WKT VLR) → `proj4(wkt, WGS84).forward([x,y])` → per-point ECEF(`pnts-quantized.ts geodeticToEcef`=`Cartesian3.fromDegrees`) + RTC_CENTER로 배치한다.

- **happy path는 견고**: WKT1·WKT2(`PROJCRS/GEOGCRS/BOUNDCRS`) 모두 proj4 2.20.9가 처리(실측). COMPD_CS 내부 PROJCS 추출 + 선형단위 Z 보정도 있음. WKT만 있으면 EPSG 레지스트리 불필요. → **WKT2는 작업 불필요.**
- **갭 1 — no-WKT**: copc.js는 `.wkt`만 읽고 GeoTIFF GeoKeyDirectory(34735, LAS 1.2~1.3에 흔함)를 안 본다. `copc.wkt===undefined` → `toWgs=undefined` → x,y를 경위도로 그대로 → **조용히 지구 밖** ([[no-silent-failures]] 위반).
- **갭 2 — 실패 처리**: `proj4(horiz.proj, WGS84)` 생성에 try/catch 없음(잘못된 def면 throw로 전체 실패 or 조용히 오변환). per-point out-of-domain은 proj4가 silent `undefined` 반환 → NaN 좌표 가능. 가드 0.
- **override 부재**: 사용자가 CRS를 강제/보완할 옵션이 없다. 업계 전 도구(py3dtiles·PDAL·giro3d·Potree)가 table-stakes로 제공.

## 2. 목표 (BP 합의)

> **"WKT 있으면 그냥 되고, 없거나 깨지면 조용히 틀리는 대신 명확히 알려주고 한 줄(`crs`)로 고치게."**

silent 오배치(지구 밖/거울상/NaN) 제거 + override 탈출구. geoid는 업계 norm대로 scope-out.

## 3. 설계 (A안)

### 3.1 컴포넌트

**(a) `resolveCrs(wkt, opts)` — `src/copc-core.ts` 신규 (현 인라인 로직 분리·강화)**
- 우선순위(PDAL 2-mode): `opts.crs`(force, 헤더 무시) > `copc.wkt` > `opts.defaultCrs`(fill, 헤더 없을 때만) > 없음.
- 반환: `{ toWgs: Reproj, zUnit: number }` (성공 시 항상 정의) 또는 CRS 미해결이면 아래 (d)로 throw.
- proj4 converter 생성을 **try/catch** → 실패 시 actionable throw(`CRS parse failed: <def 앞부분>. Pass a proj4 string or WKT via 'crs'.`).
- 입력 형식: **proj4 string / WKT 1급**, EPSG 코드는 proj4 내장분(4326·UTM zones·3857 등) best-effort. 미등록 EPSG는 (a)의 try/catch가 명확 에러로 표면화.
- `extractHorizontalCrs`(기존)는 WKT1 `COMPD_CS/PROJCS` 슬라이스 유지. **알려진 한계**(scope 밖): WKT2 `COMPOUNDCRS` 철자는 안 자르고 통째 proj4에 넘김(저빈도, proj4가 대개 처리).

**(b) center sanity-check — reproject 정합 가드**
- CRS 해소 직후 cube center([minx,miny]→[maxx,maxy] 중점)를 1회 reproject → 결과가 `lon∈[-180,180] && lat∈[-90,90]` 아니면 throw(`CRS reproject out of range (lon,lat)=… — wrong CRS or axis order?`).
- mirror/axis-swap/garbage def를 조기 차단(BP의 #1 footgun). 점 루프 진입 전 1회만 → 비용 무시.

**(c) 옵션 표면화 — `src/copc-tileset.ts` `CopcTilesetOptions`**
- `crs?: string` — force override(헤더 CRS 무시).
- `defaultCrs?: string` — fill-if-missing(헤더에 CRS 없을 때만).
- `openCopc(url, opts)` 시그니처에 두 값 전달 → `resolveCrs`로.

**(d) no-CRS → fail-loud**
- `opts.crs` 없음 + `copc.wkt` 없음 + `opts.defaultCrs` 없음 → `fromUrl` 초기화 단계에서 actionable throw(`COPC has no embedded CRS (no WKT). Pass crs:'EPSG:xxxx' / proj4 string / WKT, or defaultCrs.`). SW 경로 500이 아니라 조기 reject.

**(e) geoid scope-out — 문서화**
- 주석 + README 1줄: heights는 ellipsoidal(HAE)로 취급, 입력이 orthometric(geoid)이면 수십 m 수직 오프셋 가능 — 업계 web-viewer norm(Potree·giro3d·py3dtiles 동일).

### 3.2 데이터 흐름
```
fromUrl(url, {crs?, defaultCrs?})
  └ openCopc(url, {crs, defaultCrs})
      └ resolveCrs(copc.wkt, {crs, defaultCrs})   ── try/catch + 우선순위
          └ { toWgs, zUnit }  또는  throw (no-CRS / parse fail)
      └ center sanity-check(cube)                   ── 범위밖 throw
  └ (이후 decodeNode per-point reproject·배치 — 무변경)
```
헤드리스 `loadCopcPoints`(verify 경로)도 동일 `resolveCrs` 사용 → 단일 진실원.

### 3.3 무엇을 안 하는가 (YAGNI·scope 가드)
- GeoTIFF GeoKeyDirectory 자동파싱 → EPSG 복구 → epsg-index 번들 = **B안(follow-up)**. override로 우회 가능하므로 제외.
- frame-transform 리아키텍처 = 기각(per-point가 이미 더 정확·검증됨).
- geoid/vertical datum 보정 = scope-out(업계 norm).
- 풀 EPSG 레지스트리 번들 = B안.

## 4. 검증 기준 (Acceptance Criteria — 이진)
- [x] **AC1**: WKT 없는 COPC(또는 `wkt=undefined` 주입) + override 없음 → 명확한 throw, silent 지구밖 0. 헤드리스 재현.
- [x] **AC2**: `crs:'<proj4/EPSG/WKT>'` → 헤더 CRS 무시하고 지정 CRS로 배치(배치 좌표 변화로 검증).
- [x] **AC3**: `defaultCrs` → 헤더 WKT 있으면 무시, 없으면 적용(두 경로 모두 검증).
- [x] **AC4**: 잘못된 crs string → 생성 단계 throw(silent NaN 아님).
- [x] **AC5**: 의도적 wrong CRS로 reproject center가 lon/lat 범위 밖 → throw.
- [x] **AC6**: 기존 autzen/millsite/sofi georef 회귀 0 — `npm run verify` C1 PASS + `npm run build`(tsc) 통과.
- [x] **AC7**: geoid scope-out 문서화(주석 + README 1줄) 존재.

## 5. 테스트 시나리오
- **정상**: autzen(WKT projected) → center ≈ `-123.069°, 44.056°`(기존값 불변, 회귀 0).
- **엣지**:
  - `wkt=undefined` + `defaultCrs='EPSG:32610'`(내장 UTM) → 정상 배치.
  - `wkt=undefined` + override 없음 → AC1 throw.
  - `crs` force가 헤더 WKT를 실제로 덮어쓰는지(다른 CRS 주입 시 배치 이동).
- **실패**:
  - `crs='garbage'` → AC4 throw.
  - 의도적 wrong CRS(예: 엉뚱한 UTM zone) → AC5 center 범위밖 throw.

## 6. 알려진 한계 (정직)
- EPSG 코드 override는 proj4 내장분만(일반 UTM·WGS84·WebMerc). 그 외 EPSG는 proj4 string/WKT 전달 필요 — 문서화. (풀 레지스트리 = B안.)
- WKT2 `COMPOUNDCRS` 철자 compound는 `extractHorizontalCrs` 미슬라이스(저빈도).
- geoid 미보정(업계 norm).
