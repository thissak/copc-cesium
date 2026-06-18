# #01 CopcTileset under-refine — geometricError magnitude

Status: In Progress · Label: bug · Branch: worktree-eptium-bench
근거 벤치: `docs/bench/FINDINGS.md` (v2 millsite, 실 GPU M4 Pro)

## 1. 문제 (재현)

동일 데이터(millsite)·동일 octree·동일 framing·**동일 msse=8**에서:

| | ours | eptium(reference) |
|--|------|--------|
| tilesReady | **1** (루트만) | 109 |
| pointsSelected | **40,535** | 1,486,522 (37×) |

우리 refine 곡선: `msse8→40,535 · msse4→85,189 · msse1→712,458`(이때도 25s 미settle). Eptium은 msse8 하나로 1.49M. → **같은 품질 설정에서 우리가 옥트리를 거의 refine하지 않는다.**

**재현 명령(red):** `npm run bench:eptium -- --ds millsite --msse 8 --target ours`
→ 현재 `tilesReady=1, pointsSelected≈40k` (FAIL: 루트만 로드).

## 2. 원인 분석 (근본)

`src/tileset.ts:30-31`:
```ts
const spacingM = s.spacing * s.zUnit;
return { ..., geomError: spacingM / 2 ** d };   // 노드 depth d
```
`s.spacing = copc.info.spacing`.

Cesium 정제 판정: `SSE = geometricError · (screenH/2) / (dist · tan(fov/2))`, `SSE ≥ msse`면 refine. **geometricError가 작으면 SSE가 작아 refine 안 함.**

- COPC 사실: `info.spacing = cube_size / RootCellCount`, `RootCellCount = int(128·√3/1.5) ≈ 147` (PDAL copcwriter). 즉 `spacing ≈ cube_size / 147`.
- 우리 노드 geomError = `spacing/2^d = (cube_size/147)/2^d`.
- 결과: 노드 geometricError가 **표준 대비 ~9.2× 작음** → 같은 msse에서 SSE 9.2× 작음 → 루트만 통과. 관측된 "msse≈1에서야 refine"(≈8×)과 일치.

**방향(루트=최대, depth↑ 감소)은 정상. magnitude(base를 cube가 아닌 spacing으로 잡음)가 오류.**

## 3. Best Practice 조사

| Source | geomError 공식 | base | divisor |
|--------|---------------|------|---------|
| **ept-tools** (Connor Manning / Entwine 저자 = Eptium 혈통) | `boundsWidth/16/2^d` | cube_size | **16** |
| loaders.gl COPC | `spacing/2^d` | spacing | 1 (클라이언트 리더, 낮은 msse 의존) |
| py3dtiles | `‖aabb‖/2^d` | 3D 대각선 | 1 |
| 3D Tiles spec | depth마다 절반, root∝extent, parent>child 단조 | extent | — |

출처: github.com/connormanning/ept-tools (tileset.ts: `Bounds.width/16`, constants.ts: `geometricErrorDivisor=16`), PDAL copcwriter(Common.hpp RootCellCount≈147), CesiumGS/3d-tiles spec, Cesium3DTile.js SSE.

엣지/위험: ① 단조성(parent>child) 유지 필수 — `rootGE/2^d`는 유지됨. ② cube는 정육면체라 X변 사용 OK. ③ 보정 후 msse=8이 공격적이 되어 **deep-load가 느리고/flaky**(별도 이슈 후보, FINDINGS v3 #2).

**채택**: ept-tools 관례(Eptium과 같은 혈통) — `geomError(d) = cube_size·zUnit / 16 / 2^d`.

## 4. 수정 내용 (승인 대기)

`src/tileset.ts` only. base를 `spacing`→`cube_size/16`로:
```ts
// nodeRegionAndError (line 30-31)
- const spacingM = s.spacing * s.zUnit;
- return { region: [...], geomError: spacingM / 2 ** d };
+ const rootGE = ((s.cube[3] - s.cube[0]) * s.zUnit) / 16; // ept-tools: cube/16
+ return { region: [...], geomError: rootGE / 2 ** d };
// buildTileset (line 81-84)
- const spacingM = s.spacing * s.zUnit;
- geometricError: spacingM * 2,
+ const rootGE = ((s.cube[3] - s.cube[0]) * s.zUnit) / 16;
+ geometricError: rootGE * 2,
```

## 5. 검증 결과 — PASS

`src/tileset.ts` 수정 후 동일 bench 재실행 (실 GPU M4 Pro):

| 측정 | BEFORE | AFTER | eptium(ref) | 판정 |
|------|--------|-------|-------------|------|
| millsite tilesReady | 1 | **79** | 109 | ✅ ≥30 |
| millsite pointsSelected | 40,535 | **728,448** | 1,486,522 | ✅ 동일 자릿수(격차 37×→~2×) |
| autzen pointsSelected (회귀) | 61,201 | **1,460,660** | — | ✅ ok:true, refine 24×↑ |
| `npm run build` | — | ✓ built | — | ✅ |

- red→green 확인: 같은 msse=8에서 루트 1타일 → 79타일로 정상 refine.
- 단조성: `rootGE/2^d` 구조 유지 → parent>child 불변.

**잔여(별도 이슈 후보):** ours millsite는 ttd=25s에 미settle(728k에서 계속 스트리밍) — refine *양*은 맞췄으나 deep-load *속도/안정성*이 Eptium(7.3s settle, 1.49M)보다 느림. → FINDINGS v3 #2 (워커 풀·요청 동시성·SW 경로). 이 이슈(#01 calibration) 범위 밖.

**Status: Resolved 후보.**
