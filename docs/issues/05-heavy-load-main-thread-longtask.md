# #05 무거운 로드 메인스레드 longTask / frametime p95 — 극한 부하 부드러움 최적화

Status: Closed (결함 아님 — 전제 거짓, 측정으로 ours ≤ eptium 확인) · Label: task (perf investigation)
발견 경로: #04 머지 후 sofi(1.9GB) Eptium 최종 검증(2026-06-18). msse=4 극단 부하 head-to-head 에서 ours 가 메인스레드 longTask·p95 에서 eptium 에 뒤짐.
재현 하니스: `scripts/bench/repro-05.ts` (CDP CPU 프로파일 + longTask 계측, 작성 예정).

> 방침([[optimize-to-the-extreme]]): 측정 가능한 비효율은 극단/엣지까지 제거한다. "정상영역(msse=8) 무관"으로 넘기지 않는다. 단 measure-first — longTask 정체를 *측정으로* 못박고 근본을 제거한다(추측 최적화 금지). throttle/streaming 손코딩 전 BP(STOP 규칙).

## 1. 문제 (관측 — RED 후보)

sofi(1.9GB) msse=4(4.29M점·188타일, 실 GPU M4 Pro) ours vs eptium 동일 카메라 측정(`docs/bench/eptium-sofi.md`):

| 지표 | ours | eptium |
|------|------|--------|
| frametime p50 | 8 ms (120fps) | 8 ms (120fps) |
| **frametime p95** | **23 ms** | 10 ms |
| **longTask 합(메인스레드 freeze)** | **219 ms** | 0 ms |
| hitch (>50ms, 가시 끊김) | 1 | 1 |
| peak heap | 258 MB | 288 MB (ours 우위) |

**판독:** 평상시(p50)·가시 끊김(hitch)은 동률이나, **무거운 로딩 중 메인스레드가 ~219ms 블록**되며 최악 5% 프레임(p95)이 eptium 의 2배 이상 튄다. eptium 은 서버 사전변환(3D Tiles)이라 브라우저 메인스레드 부담이 0 — 우리 "변환 없이(브라우저 즉석 디코드·조립)" 아키텍처(ADR-001)의 메인스레드 비용이 극한 부하에서 표면화된 것.

**가설(Step 1 에서 측정으로 판별):**
- (a) Cesium 내부 — pnts 파싱 + GPU 버퍼 업로드(메인스레드, 우리가 위임한 영역)
- (b) 우리 글루 — SW↔워커 메시지·transfer·핸들러
- (c) 타일 쇄도 — 188 타일 동시 도착 → 처리 큐 폭주(한 프레임에 여러 타일 처리)
- (d) GC — 4M점 메모리 churn 으로 V8 GC pause

**영향 범위:** 극단 refine(msse=4) on 초대형 데이터(sofi 1.9GB). 정상 영역(msse=8, millsite 매칭)은 ours p50 8.3ms·hitch 0 으로 eptium 동률(깨끗). 입상 데모는 정상 영역이나, "빠르고 부드럽게" 극한 경쟁력 차원에서 제거 대상.

## 2. 원인 분석 (Step 1 CDP CPU 프로파일 — 전제 뒤집힘)

**측정 결과, 섹션 1의 "ours 219ms vs eptium 0ms" 전제가 robust 하지 않다.** CDP CPU 프로파일(메인스레드만 샘플 → 워커 디코드 제외)로 sofi 무거운 부하를 떠보니:

| 메인스레드 self-time | ours | eptium(viewer.copc.io, 동일 방식) |
|------|------|------|
| `ShaderCache.getDerivedShaderProgram` | 1,237ms | **2,532ms** |
| 바쁜(non-idle) 합 | ~5,000ms | **13,820ms** |
| longTask max | 71–90ms | 114ms |
| frametime p99 / max | 21.9 / 90ms | 39.7 / 174ms |
| **우리 코드(ours-main)** | **47–60ms (0.4%)** | — |

**사실:**
1. **우리 코드는 병목이 아니다** — 메인스레드 바쁜 시간의 0.4%(47–60ms). 디코드·조립은 워커에 있어 메인스레드 밖.
2. **비용 = Cesium 의 pnts→`Model3DTileContent` 파이프라인** (`getDerivedShaderProgram` 셰이더 유도 + `ModelSceneGraph.pushDrawCommands` + `Context.draw` + 행렬연산). EDL/attenuation 무관(A/B: ON 1237ms vs OFF 1181ms 동일).
3. **Eptium 도 같은 Cesium → 같은 비용을 더 많이 낸다**(셰이더 유도 2532ms, 바쁜시간 13820ms). 즉 우리가 Eptium 보다 무겁지 않다 — 오히려 가볍다.
4. 섹션 1 의 "eptium 0ms"는 **측정창 아티팩트**(settle 후 stress 창만 집계 — 우리는 아직 churn 로딩 중, Eptium 은 정착 후 idle). Eptium readPixels 는 마우스 hover 피킹(`handlePointerMove→drillPick`)으로 우리와 무관.

**결론:** ours-특정 메인스레드 결함은 **없다**. 셰이더 유도는 **양쪽 공통**(Cesium point-cloud Model 렌더의 본질) 이고 ours ≤ eptium.

**게이트 체크 (일회성 vs 재발생):** settle *후* churn 구간만 프로파일(`CHURN_ONLY=1 repro-05`) → `getDerivedShaderProgram` 가 **전체 1,237ms 중 churn 구간은 153ms/12s** 뿐. 즉 ~88%(1,084ms)가 **초기 로딩 1회**(이후 캐시 reuse), churn 재유도는 13ms/s 로 미미·가시 끊김 무관(longTask 1·max 75ms). → **고칠 recurring 비효율 없음**(precompile/share 로 줄일 여지는 *일회성 로드 스파이크*뿐, 비례성 낮음).

## 3. Best Practice 조사 (N/A)

근본 결함이 없어 수정 대상 없음. 셰이더 유도 자체는 Cesium `ShaderCache` 내부(`getDerivedShaderProgram`)이며 ours·eptium 공통, 대부분 일회성. (향후 로드-스파이크 자체를 줄이려면 ShaderCache 워밍/변형 통일이 후보지만, 현재 ROI 낮음 — 별도 백로그.)

## 4. 수정 (없음)

코드 수정 없음. 진단 하니스만 추가: `scripts/bench/repro-05.ts` (CDP CPU 프로파일 — 메인스레드 self-time 분류·콜패스·churn-only 모드·ours/eptium 동일 비교). 재사용 가능한 perf 프로파일러로 유지.

## 5. 검증 / 결론 (Status → Closed: 결함 아님)

| 검증 | 결과 |
|------|------|
| ours 메인스레드 self-time | 0.4%(47–60ms) — 우리 코드 병목 아님 |
| 셰이더 유도 ours vs eptium | 1,237ms vs **2,532ms** — ours 가 더 가벼움 |
| EDL/atten A/B | ON 1,237 vs OFF 1,181ms — 무관(시각 설정 원인 아님) |
| 게이트(churn-only 재유도) | 153ms/12s — 일회성 amortized, recurring 비효율 없음 |
| 가시 끊김(hitch>50ms) | ours·eptium 동률, ours max frametime ≤ eptium |

**판정: 결함 아님 (전제 거짓) → Closed.** 섹션 1 의 "ours 219ms vs eptium 0ms" 는 측정창 아티팩트였고, 동일 방식 프로파일 시 ours 가 eptium 보다 메인스레드 부담이 가볍다. measure-first 가 "없는 버그 추격"을 차단([[optimize-to-the-extreme]] 의 올바른 적용 — 측정으로 비효율 *없음*을 확인). `/issue-track close #05` 대상(resolution: not-a-defect).

---
잔여 백로그(낮은 우선순위): 초기 로딩 셰이더 유도 스파이크(~1s) 자체를 ShaderCache 워밍/변형 통일로 줄이면 *로드 시간*에 도움될 수 있음 — 단 ours 가 이미 eptium 보다 적게 내므로 경쟁력 차원 불요. 추후 로드 최적화 시 재검토.

---
스코프 메모: 이 이슈는 메인스레드 longTask/p95 한정. 발견되는 다른 문제는 새 이슈로.
