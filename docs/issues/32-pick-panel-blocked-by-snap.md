# #32 클릭 결과 패널이 느린 snapPoint 를 기다리느라 수 초 뒤에야 뜬다

**Issue**: (로컬 문서 전용 — 공개 repo GH 이슈 미등록)
**Status**: Resolved (후보 — `/issue-track close #32` 대기)
**Created**: 2026-08-16
**Resolved**: 2026-08-16

---

## 1. 문제

### 증상
- 점군을 클릭해도 **패널이 즉시 뜨지 않고 5~6초 뒤에** 나타난다.
- 그 사이 화면에는 아무 피드백이 없어, 클릭이 먹었는지 알 수 없다.
- 좌표·분류·강도 같은 **이미 확보된 정보까지 같이 지연**된다.

### 재현 조건
- 환경: Windows 11, Chromium 149, RTX 4090, 1920×1080
- 단계:
  1. `npm run dev` → `http://localhost:5173/?ds=autzen`
  2. 로드 완료 후 점군을 클릭
  3. 우상단 패널이 뜰 때까지 걸리는 시간 관찰

### 스크린샷 / 로그
출품 시연영상 점 조회 구간 촬영 중 발견. 클릭 시각과 패널 등장 시각을 프레임으로 대조:

| 클릭 | 패널 등장 |
|---|---|
| 1.0s | — |
| 4.5s | — |
| 8.5s | **10s** |
| 12.5s | **13s** |

1·1.5·3·5·7초 프레임에 패널 없음. 일관되게 **약 5~6초 지연**.

---

## 2. 원인 분석

### 근본 원인
`demo/pick-panel.ts`

```ts
const hit = pickPoint(tileset, viewer.scene, movement.position);   // 즉시 반환
...
lines.push(Lon/Lat/Height, ...속성);                                // 표시할 내용은 이미 다 있다
const snapped = await tileset.snapPoint(viewer.scene, movement.position);  // ← 느리다
if (snapped) lines.push(`snap: …`);
panel.textContent = lines.join('\n');                              // 여기서야 처음 그린다
panel.style.display = 'block';
```

`pickPoint` 는 동기적으로 끝나 좌표·LAS 속성이 **즉시** 준비된다. 그런데 패널을 그리는 지점이
`await snapPoint(...)` **뒤**라, 옵션 정보인 snap 한 줄 때문에 **이미 가진 정보 전부가 인질**이 된다.

`snapPoint` 가 느린 것 자체는 설계대로다 — 렌더 픽셀이 아니라 **옥트리 최심 노드를 그 시점에 받아
디코드해 실제 최근접 점**을 찾는다(이슈 #3-B). 무거운 게 정상이고, 그래서 더더욱 **기다리게 하면 안 된다.**

---

## 3. Best Practice 조사

### 조사 항목
- 빠른 결과와 느린 보강 결과가 섞일 때의 표시 전략(progressive disclosure).

### 프로덕션 사례
| 프로젝트 | 접근 방식 | 비고 |
|---|---|---|
| 본 프로젝트 `snapPoint` 계약 | 실패 시 `undefined` 를 반환해 **호출측이 계속 진행**하도록 설계 | 이미 "없어도 되는 정보"로 규정돼 있다 |
| 일반 UI 관행 | 확보된 정보를 먼저 그리고, 늦게 오는 값은 도착 시 덧붙인다 | 클릭 피드백은 즉시가 원칙 |

### 엣지 케이스 / 위험 요소
| 시나리오 | 위험도 | 대응 |
|---|---|---|
| 연속 클릭 시 늦게 온 snap 이 **다른 점**의 패널에 붙음 | 높 | 클릭마다 토큰을 부여해 최신 클릭의 응답만 반영 |
| snapPoint 실패/타임아웃 | 중 | 이미 `undefined` 계약 — 기본 패널은 그대로 유지 |

---

## 4. 수정 내용

### 변경 파일
| 파일 | 변경 요약 |
|------|----------|
| `demo/pick-panel.ts` | 확보된 정보를 즉시 그린 뒤, snap 이 도착하면 덧붙인다. 클릭 토큰으로 늦은 응답 무시 |

### Before / After
```typescript
// Before — snap 을 기다린 뒤에야 처음 그린다 (클릭 피드백이 5~6초 지연)
const snapped = await tileset.snapPoint(scene, pos);
if (snapped) lines.push(`snap: …`);
panel.textContent = lines.join('
');
panel.style.display = 'block';

// After — 즉시 그리고, 늦게 온 snap 만 덧붙인다
panel.textContent = lines.join('
');
panel.style.display = 'block';
const snapped = await tileset.snapPoint(scene, pos);
if (snapped && token === clickToken) {      // 그 사이 다른 점을 찍었으면 버린다
  lines.push(`snap: …`);
  panel.textContent = lines.join('
');
}
```

### PR
(브랜치 `fix/28-zoomto-frames-octree-cube` 에 동승)

---

## 5. 검증 결과

### 테스트 방법
`scripts/video/record.ts autzen-pick` 로 촬영한 클립에서 클릭 시각 대비 패널 등장 시각을 프레임으로 대조한다.
클릭은 경로 시작 후 1 · 4.5 · 8.5 · 12.5초에 자동 발생한다.

### 결과
| 항목 | 수정 전 | 수정 후 | 판정 |
|------|---------|---------|------|
| 클릭 → 패널 등장 | 약 5~6초 | **1.5초 프레임에 이미 표시** | PASS |
| 구간 앞부분 빈 화면 | 12.7초 중 앞 6초(47%) | **없음** | PASS |
| 클릭마다 내용 갱신 | — | 확인 (Classification 2→5, Intensity 37376→256) | PASS |
| 오프라인 체크 9종 | 9/9 | **9/9** | 회귀 없음 |
| `tsc --noEmit` | 통과 | 통과 | 회귀 없음 |

### 잔여 이슈
- snap 줄이 뒤늦게 붙으면서 패널 높이가 한 번 늘어난다. 시연에서는 "원본 점을 찾아왔다"는 신호로 읽혀
  오히려 유용해 자리표시자를 두지 않았다.
