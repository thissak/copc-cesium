# #17 deep-load 내부 병목: reproject(proj4 수평변환)가 내부 compute의 50%

**Issue**: https://github.com/thissak/CopcCesiumLab/issues/17
**Status**: Open
**Created**: 2026-06-22
**Resolved**: -
**Label**: enhancement (perf / 내부 compute)

> 발견 경로: 4축 병목 분해 하니스(이슈 #14 후속, `scripts/bench/profile-axes`·`run-axis-profile`, PR #16)로 내부 계산을 IO/decode/CPU 분해 측정 중 발견. 네트워크(IO=TTFB) 축은 #14, 본 건은 *내부 compute* 축 1순위.

---

## 1. 문제

### 증상
deep-load 노드 처리의 **내부 계산(IO 제외) 시간 50%가 reproject(proj4 수평 좌표변환)**에 소요. laz 디코드(43%)보다 크다. IO를 로컬 서버로 통제(3%)하면 reproject가 단일 최대 축으로 드러남. "느린 deep-load"의 내부 compute 레버는 디코드가 아니라 **좌표 재투영**.

### 재현 조건
- 환경: Node, 로컬 range 서버 + 정규화 COPC(PDAL decimation, autzen 2.13M점), Apple M-series.
- 단계: `bash scripts/bench/gen-norm-copc.sh` → `npm run profile:axes -- data/norm-autzen-2M.copc.laz 5 5`

### 측정 데이터 (depth≤5 · 65노드 · 5회 median · ×2회 재현, 축% 변동 0%p)
| 축 | % | ms/1M점 |
|----|---|---------|
| IO(local) | 3% | 32.5 |
| decode(laz+xyz추출) | 43% | 504.9 |
| **reproject(proj4 수평)** | **50%** | **582.2** |
| build(ecef+양자화+pack) | 5% | 55.8 |
| internal 합 | 100% | (2504ms / 2.13M점) |

- raw autzen 로컬서빙에서도 동일(IO 3 · decode 42 · reproject 50 · build 5) → 입력 무관 견고.
- 축 경계: reproject = proj4 수평(lon/lat)만. (build의 geodeticToEcef는 별도 축.)

---

## 2. 원인 분석 (1차 — 측정으로 확정한 위치)

### 측정 데이터
위 표. 정규화·raw 양쪽 일치, 2회 재현 변동 0%p → 결정적.

### 근본 원인 (위치)
`src/copc-core.ts` `loadCopcPoints`/`decodeNode`의 점 루프가 **점마다 `toWgs.forward([x, y])`를 호출**한다 (`src/copc-core.ts:119-126` 부근):
```ts
for (let i = 0; i < n; i++) {
  const x = gx(i); const y = gy(i); const z = gz(i) * zUnit;
  const out = toWgs.forward([x, y]) as number[];   // ← 점당 proj4 호출 + [x,y] 배열 할당
  lonLatH.push(out[0], out[1], z);
}
```
- 2.13M점 × **per-point proj4.forward 호출**(함수 호출 오버헤드 + 호출당 투영 수학) + 점마다 `[x,y]` 임시배열 할당 → 582 ms/1M점.
- decode(laz)는 50k점 청크 배치 디코드라 점당 비용이 낮은데, reproject는 점 단위 스칼라 호출이라 더 비싸다는 게 측정의 함의(가설 — BP/검증서 확정).

---

## 3. Best Practice 조사 (issue-resolve 시 작성 — STOP 규칙: 좌표변환 최적화 전 BP 조사)

### 조사 항목 (착수 전 확인할 것)
- proj4 **배치 변환** API 유무(`forward` 벡터화/`forwardArray`?) 및 점당 배열할당 제거(in/out 재사용 버퍼).
- Lambert(autzen CRS)→WGS84 **변환식 직접 구현/사전계산**(proj4 범용 경로 우회) 타당성·정확성 trade-off.
- 워커서 변환을 **typed array 일괄** 처리(스칼라 루프 대신) 가능성.
- prior art: Potree/giro3d/py3dtiles의 reproject 처리 방식.

### 프로덕션 사례
| 프로젝트 | 접근 방식 | 비고 |
|---------|----------|------|
| (issue-resolve 시) | | |

### 엣지 케이스 / 위험 요소
| 시나리오 | 위험도 | 대응 |
|---------|--------|------|
| 정확성 회귀(좌표 오차) | 높 | 골든파일 byte/좌표 동일성 게이트 (verify C1) |
| CRS 다양성(Lambert 외) | 중 | 범용 proj4 폴백 유지 |

---

## 4. 수정 내용
(미해결 — issue-resolve 단계서 작성)

### 변경 파일
| 파일 | 변경 요약 |
|------|----------|
| | |

### PR
-

---

## 5. 검증 결과
(미해결 — issue-resolve 단계서 작성. 검증 도구 = `scripts/bench/run-axis-profile.ts`로 reproject ms/1M점 before/after + 정확성 verify C1)

### 결과
| 항목 | 수정 전 | 수정 후 | 판정 |
|------|---------|---------|------|
| reproject ms/1M점 | 582.2 | | |

### 잔여 이슈
-

---
스코프: 내부 compute reproject 한정. 네트워크 brittle은 #14, GPU/메인스레드 축은 4축 하니스 후속(GPU 미구현).
