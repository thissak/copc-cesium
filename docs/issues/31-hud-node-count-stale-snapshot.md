# #31 데모 HUD의 "로드된 노드" 가 갱신되지 않아 실제와 다른 수를 표시한다

**Issue**: (로컬 문서 전용 — 공개 repo GH 이슈 미등록)
**Status**: Resolved (후보 — `/issue-track close #31` 대기)
**Created**: 2026-08-16
**Resolved**: 2026-08-16

---

## 1. 문제

### 증상
- 데모 HUD 의 `로드된 노드: N (실패 M)` 이 **초기 1회만 찍히고 이후 영원히 갱신되지 않는다.**
- 스트리밍이 계속 도는데도 화면의 숫자는 멈춰 있어, 보는 사람이 "노드가 안 늘어난다"고 읽는다.
- 대형 데이터(SoFi 1.9GB)는 스냅샷 시점에 아직 아무 노드도 안 끝나 **`로드된 노드: 0`** 이 박힌다.

### 재현 조건
- 환경: Windows 11, Chromium 149, RTX 4090, 1920×1080
- 단계:
  1. `npm run dev`
  2. `http://localhost:5173/?ds=sofi`
  3. 로드 후 화면을 계속 두고 카메라를 움직여 타일을 더 받게 한다
  4. HUD 의 `로드된 노드` 가 **변하지 않는다** (SoFi 는 `0` 에 고정)

### 스크린샷 / 로그
출품 시연영상 촬영 중 발견. 최종본 s8 구간(SoFi 심화 스트리밍) 프레임:

```
SoFi Stadium (대형 · 벽) — CopcTileset.fromUrl()
변환 없이 원본 COPC 직접 · LOD 스트리밍
로드된 노드: 0 (실패 0)
로드 6570ms · 줌하면 디테일이 채워집니다
```

같은 화면의 나레이션·자막은 "기가바이트급에서도 보이는 만큼만 스트리밍합니다" 였다.
**화면의 증거가 주장을 반증하는 상태** — 영상에 그대로 나가면 신뢰를 잃는다.

다른 구간도 같은 이유로 낡은 값이었다: s6(Autzen dive) `6`, s7(SoFi orbit) `22`.
반면 실제 안정화 후 노드 수는 Autzen 60 · SoFi 78 이다(`repro-28`/`repro-30` 실측).

---

## 2. 원인 분석

### 측정 데이터
| 구간 | HUD 표시 | 실제(안정화 후) |
|---|---|---|
| Autzen dive (s6) | 6 | 60 |
| SoFi orbit (s7) | 22 | 78 |
| SoFi dive (s8) | **0** | 78 |

### 근본 원인
`demo/main.ts` `runDemo()`

```ts
let tileLoaded = 0;
tileset.tileLoad.addEventListener(() => { tileLoaded++; });   // 카운터는 계속 증가하지만
...
await new Promise((res) => setTimeout(res, 4000));            // 딱 4초 기다린 뒤
log(`… 로드된 노드: ${tileLoaded} (실패 ${tileFailed}) …`);    // 그 순간 값을 한 번만 그린다
```

카운터 자체는 정확하다. **HUD 를 다시 그리지 않는 것**이 문제다. 4초는 Autzen 조차 다 못 받고,
SoFi(1.9GB)는 그 시점에 완료된 노드가 0 이라 `0` 이 고정된다.

`로드 …ms` 도 같은 log 문자열에 들어 있어, 단순히 주기적으로 다시 그리면 **초기 로드 시간이 계속 늘어나는**
다른 오류가 생긴다. 초기 로드 시간은 고정하고 노드 수만 갱신해야 한다.

---

## 3. Best Practice 조사

### 조사 항목
- 실시간 카운터를 화면에 표시할 때의 갱신 빈도 — 매 이벤트마다 DOM 을 건드리면 스트리밍 부하 구간에서 렌더를 방해한다.

### 프로덕션 사례
| 프로젝트 | 접근 방식 | 비고 |
|---|---|---|
| Cesium `debugShowFramesPerSecond` | 자체 오버레이를 프레임 루프에서 갱신 | 렌더 루프에 얹는 것이 표준 |
| 본 프로젝트 `runSoak`/`runPerf` | 측정 루프에서 주기적으로 `log()` 재호출 | **같은 파일에 이미 있는 관례** — 따르면 된다 |

### 엣지 케이스 / 위험 요소
| 시나리오 | 위험도 | 대응 |
|---|---|---|
| tileLoad 폭주 시 DOM 갱신 과다 | 중 | 이벤트마다 그리지 말고 주기 갱신(rAF/타이머)으로 합친다 |
| 초기 로드 시간이 계속 증가 | 높 | `loadMs` 를 1회 확정해 고정하고 노드 수만 갱신 |
| 갱신 타이머 누수 | 중 | 데모 페이지 수명과 같이 가므로 무해하나, 정지 조건 없이 무한 루프는 피한다 |

---

## 4. 수정 내용

### 변경 파일
| 파일 | 변경 요약 |
|------|----------|
| `demo/main.ts` | HUD 를 `paint()` 로 분리해 250ms 주기로 다시 그린다. 초기 로드 시간은 `loadMs` 로 고정 |
| `scripts/bench/repro-31.ts` | 재현·검증 스크립트 (신규) |

### Before / After
```typescript
// Before — 4초 시점 값을 한 번만 그린다
await new Promise((res) => setTimeout(res, 4000));
log(`… 로드된 노드: ${tileLoaded} (실패 ${tileFailed})
로드 ${(performance.now() - t0).toFixed(0)}ms …`);

// After — 로드 시간은 고정, 노드 수는 값이 바뀔 때만 4Hz 로 다시 그린다
const loadMs = performance.now() - t0;
const paint = () => log(`… 로드된 노드: ${tileLoaded} (실패 ${tileFailed})
로드 ${loadMs.toFixed(0)}ms …`);
paint();
let lastShown = -1;
setInterval(() => {
  const sig = tileLoaded * 1e6 + tileFailed;
  if (sig !== lastShown) { lastShown = sig; paint(); }
}, 250);
```

### PR
(브랜치 `fix/28-zoomto-frames-octree-cube` 에 동승)

---

## 5. 검증 결과

### 테스트 방법
`scripts/bench/repro-31.ts` — dev 서버 기동 후 `tsx scripts/bench/repro-31.ts [ds]`.
안정화까지 기다린 뒤 **화면의 HUD 문자열에서 읽은 노드 수**와 `tileset.statistics.numberOfTilesWithContentReady` 를 대조한다.
합격: 실패 0 이고 HUD 가 실제의 50% 이상을 반영.

### 결과
| 항목 | 수정 전 | 수정 후 | 판정 |
|------|---------|---------|------|
| SoFi — HUD 노드 수 | **0** (실제 22) | **78** (실제 78, 100%) | PASS |
| Autzen — HUD 노드 수 | 6 (실제 60) | **65** (실제 60, 108%) | PASS |
| 오프라인 체크 9종 | 9/9 | **9/9** | 회귀 없음 |
| `tsc --noEmit` | 통과 | 통과 | 회귀 없음 |

Autzen 이 108% 인 것은 정상이다 — HUD 는 **누적 `tileLoad` 이벤트 수**, `statistics` 는 **현재 준비된 타일 수**라
언로드된 만큼 차이가 난다. 두 값의 의미가 달라 완전 일치를 기대하지 않는다.

### 잔여 이슈
- 이 결함으로 **출품 시연영상의 모든 클립이 낡은 노드 수를 표시**하고 있었다(s6=6, s7=22, s8=0).
  특히 s8 은 "기가바이트급에서도 보이는 만큼만 스트리밍" 나레이션과 화면의 `0` 이 정면 충돌했다.
  수정 후 **전 클립 재촬영**이 필요하다. (이웃 세션 교차검토에서 발견)
