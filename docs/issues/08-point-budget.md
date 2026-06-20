# #08 Point budget 부재 — 깊은 줌 무제한 SSE refine으로 GPU-bound

Status: Open (BP 조사 대기 — 다음 작업) · Label: enhancement (perf / LOD)
발견 경로: 공정 비교 도구(fair-compare) 작업(2026-06-20). Eptium 대비 단일 verdict는 불가(자기검증 거부)했으나, 그 진단 과정에서 **두 엔진의 LOD 전략 차이**를 측정으로 발견. 상세: `docs/bench/FINDINGS.md` §2026-06-20, 설계 `docs/superpowers/specs/2026-06-20-fair-engine-bench-design.md`.
재현 하니스: `scripts/bench/fair-probe.ts` `measureLoadCurve`(GPU 타이머 GPU ms vs 점수) + 인라인 plateau 측정.

> 방침([[optimize-to-the-extreme]] · STOP 규칙): point budget = **LOD/스트리밍 영역 → 손코딩 전 BP 조사 + 계획 + 검증기준 → 승인 후 착수.** #05 교훈(전제 거짓이 measure-first로 드러남)을 반복하지 않게, "캡이 실제로 부드러움을 사고 시각 품질을 안 깎는가"를 *측정으로* 먼저 확인.

## 1. 문제 (관측)

sofi(1.9GB) 깊은 시점(boundingSphere 0.15r, globe off, 실 GPU M4 Pro Metal)에서 msse 스윕 시 plateau pointsSelected:

| msse | **ours** | **Eptium** |
|------|----------|------------|
| 32 | 1,814,024 | 763,741 |
| 16 | 5,133,477 | 763,741 |
| 8 | 10,183,337 | 763,741 |

- **ours = 무제한 SSE refine** — msse 낮출수록 점 무한정 증가, 상한 없음. 깊은 줌서 5~10M점.
- **Eptium = msse 무관 764k 고정** — 점 예산(budget) 캡.
- 성능 귀결(이전 settled-deep 측정): ours 깊은 뷰 ~58fps(GPU-bound) ↔ Eptium ~120fps. ours가 ~13× 많은 점을 그려 느림.

**영향 범위:** 깊은 줌(공격적 msse 또는 dense 영역 근접). 정상/원거리 뷰는 무관. 주최사 북극성 "부드럽게"의 깊은-줌 갭.

## 2. 원인 분석 (측정으로 확인)

**Eptium의 pointsSelected가 msse 32/16/8에서 763,741로 완전 동일** → Eptium은 SSE refine이 아니라 **고정 점 예산**을 쓴다(Potree 고전 기법: 점 예산 한도 내에서 SSE 우선순위로 분배). ours는 표준 `Cesium3DTileset.maximumScreenSpaceError` refine이라 **점 수에 상한이 없다** — 깊게 가면 무한정 늘어난다.

**가설(BP/검증서 확정):** 깊은 줌에서 5~10M점 중 상당수는 화면 픽셀 수(~1.4M)를 초과하는 **sub-pixel overdraw**라 시각 품질 기여 없이 GPU만 먹는다. 점 예산(~1~3M 캡)이면 시각 품질 유지하며 최악 GPU 비용을 *유계(bounded)* → 깊은 줌도 부드러움. (단 "품질 유지"는 측정 필요 — 반례: 넓고 성긴 데이터면 캡이 디테일을 깎을 수 있음.)

연관: #05(무거운 로드 메인스레드)는 *CPU/메인스레드*가 병목 아님을 확인(ours ≤ eptium). 본 이슈는 *GPU 렌더 비용*(그리는 점 수)이라 별개 축.

## 3. Best Practice 조사 (TODO — 다음 작업의 핵심)

손코딩 전 조사 (STOP 규칙):
- [ ] **Cesium 네이티브**: `Cesium3DTileset`에 "최대 렌더 점 수" 예산 메커니즘이 있나? (`maximumScreenSpaceError`·`cacheBytes`(메모리)·`foveatedScreenSpaceError`·`dynamicScreenSpaceError` 외에 점-예산 직접 노브 유무). 없으면 손코딩 정당화.
- [ ] **Potree `pointBudget`** 구현 방식 — 어떻게 점 예산을 SSE 우선순위로 분배하나(노드 우선순위 큐 + 예산 소진까지 refine).
- [ ] **prior art**: loaders.gl(3D Tiles)·giro3d·deck.gl 포인트클라우드의 점 예산 처리.
- [ ] **우리 아키텍처 적합성**: ours는 LOD를 Cesium에 위임(ADR-001/004). 점 예산을 (a) msse 동적 조절(거리/점수 피드백으로 msse 자동 상향)로 근사 vs (b) 노드 선택 단계 손코딩 캡 — 어느 쪽이 위임 철학에 맞나.

## 4. 수정 (TODO — 설계 후)

- [ ] 설계 spec 작성(`docs/superpowers/specs/`) — point budget 접근(동적 msse vs 선택 캡) + 검증기준.
- [ ] 구현 — pointsSelected를 목표 예산(~1~3M, config 노브)으로 캡.
- [ ] `CopcTileset.fromUrl` 옵션에 `pointBudget` 노출(기본값 결정).

## 5. 검증 / 결론 (TODO)

검증기준 후보 (이진 판정):
- [ ] **품질 유지**: 동일 깊은 시점에서 캡 전/후 시각 품질 회귀 없음(스크린샷 대조 또는 가시 점 밀도 기준).
- [ ] **부드러움 개선**: 깊은 줌 fps 58 → 목표(≥100) 개선, `measureLoadCurve`/`?perf` 실 GPU 재측정.
- [ ] **유계성**: 임의 깊이 줌에서 pointsSelected ≤ 예산(상한 보장).
- [ ] **회귀 0**: 정상/원거리 뷰·verify·골든파일 불변.

---
다음 작업(handoff): **§3 BP 조사 → §4 설계 spec(brainstorm/plan) → 승인 → 구현 → §5 검증.** measure-first로 "캡이 품질 안 깎고 부드러움 산다"를 먼저 확인(전제 검증). 측정 도구(`measureLoadCurve`)는 손에 있음.

---
스코프 메모: 본 이슈는 깊은-줌 점-예산 한정. fair-compare 도구의 노이즈(가파른 곡선)·overlap(점예산 격차) 한계는 별건(보류).
