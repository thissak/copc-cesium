# #29 Windows 에서 `npm test` 집계 러너가 전 항목 FAIL 한다

**Issue**: (로컬 문서 전용 — 공개 repo GH 이슈 미등록)
**Status**: Resolved (후보 — `/issue-track close #29` 대기)
**Created**: 2026-08-16
**Resolved**: 2026-08-16

---

## 1. 문제

### 증상
- Windows 에서 `npm test` 실행 시 **0/9 passed**, 9개 체크가 전부 FAIL 로 집계된다.
- 그런데 **같은 체크를 개별로 돌리면 9/9 통과**한다 (`npm run check:crs` … `check:public-types`).
- 즉 체크 자체가 아니라 **집계 러너**가 깨졌다. CI 신호를 신뢰할 수 없고, 회귀 검증이 불가능하다.

### 재현 조건
- 환경: Windows 11, Node v24.15.0, PowerShell/Git Bash
- 단계:
  1. `npm install`
  2. `npm test`
  3. `0/9 passed` + `FAIL ❌ check-crs, check-ecef, …` 출력
  4. 대조: `npm run check:ecef` → `ECEF PASS ✅ (Cesium 과 sub-mm 일치)`

### 스크린샷 / 로그
```
============================================
0/9 passed
FAIL ❌  check-crs, check-ecef, check-picking, check-pnts-batch, check-style,
        check-request-throttle, check-sw-routing, check-cesium-codec, check-public-types
```
개별 실행:
```
$ npx tsx scripts/check-ecef.ts
maxErr(m)=1.397e-9
ECEF PASS ✅ (Cesium 과 sub-mm 일치)
```

이슈 #28 수정 **전에도 동일하게 재현**됨(`git stash` 상태에서 확인) — #28 의 회귀가 아니다.

---

## 2. 원인 분석

### 측정 데이터
| 실행 경로 | 결과 |
|-----------|------|
| `npm test` (러너 경유) | 0/9 |
| 개별 `npm run check:*` × 9 | 9/9 PASS |

### 근본 원인
`scripts/run-checks.ts:68-70`

```ts
const command = check.command ?? 'npx';
const res = spawnSync(command, args, { stdio: 'inherit' });
```

Windows 에서 `npx` 는 실행파일이 아니라 `npx.cmd` **셸 셰임**이다. Node 18+ 는 보안 패치(CVE-2024-27980) 이후
`.cmd`/`.bat` 을 `shell: true` 없이 spawn 하면 `EINVAL` 로 거부한다. 그래서 모든 체크가 실행조차 되지 못하고
비정상 종료코드로 집계된다.

동일 결함이 세션 중 다른 곳에서도 관측됐다:
- `scripts/bench/fair-compare.ts:46` — `spawn('npx', ['vite', …])` 역시 Windows 에서 `EINVAL`.

---

## 3. Best Practice 조사

### 조사 항목
- Node.js 공식 문서(context7 `/websites/nodejs_latest-v24_x_api`)의 `child_process` — Windows `.cmd`/`.bat` 실행 규약과 `shell` 옵션의 제약.

### 프로덕션 사례
| 프로젝트 | 접근 방식 | 비고 |
|---------|----------|------|
| Node.js `child_process` 공식 문서 | "On Windows, `.bat` and `.cmd` files **cannot be executed directly**… use `exec`, or spawn `cmd.exe` with the file as an argument" | [Spawning .bat and .cmd files on Windows](https://nodejs.org/docs/latest-v24.x/api/child_process.html) |
| Node.js `spawn` shell 옵션 | shell 사용 시 "avoid passing unsanitized user input"; 인자는 이스케이프되지 않고 **연결만** 된다 | 같은 문서 |
| Node.js DEP0190 | **인자 배열 + `shell: true`** 조합은 폐기예정 — 경고 발생 | 1차 수정에서 실제로 경고를 관측해 설계를 바꿨다 |
| `tsx` 패키지 | `bin` 이 `./dist/cli.mjs` — **순수 JS**라 `node <cli.mjs>` 로 직접 실행 가능 | 셸 자체가 불필요해진다 |

**결론**: `.cmd` 셰임을 부르지 말고 **JS 진입점을 `process.execPath`(node)로 직접 실행**하는 것이 최선이다.
셸도, 인자 이스케이프도, 플랫폼 분기도 필요 없다. tsc 플래그의 SSOT 는 package.json 이라 그 한 건만
공백 없는 **단일 문자열 + shell** 로 남긴다(문자열 형태는 DEP0190 대상이 아니다).

### 엣지 케이스 / 위험 요소
| 시나리오 | 위험도 | 대응 |
|---------|--------|------|
| 인자 배열 + `shell:true` (1차안) | 높 | DEP0190 폐기예정 경고 → **채택하지 않음**. node 직접 실행으로 전환 |
| 경로에 공백 (`C:\Users\My Name\…`) | 중 | node 직접 실행 경로는 인자 배열이라 셸 인용이 아예 개입하지 않음 |
| macOS/Linux 회귀 | 높 | 플랫폼 분기를 없애 양쪽이 동일 경로를 탄다 |
| npm 스크립트의 tsc 플래그 중복 정의 | 중 | package.json 을 SSOT 로 유지하고 러너는 `npm run …` 을 그대로 호출 |

---

## 4. 수정 내용

### 변경 파일
| 파일 | 변경 요약 |
|------|----------|
| `scripts/run-checks.ts` | `npx` 셰임 호출 제거 → `node <tsx/cli.mjs> <script>` 직접 실행. `Check.command/args` 를 `shellCommand?` 하나로 축소 |

### Before / After
```typescript
// Before — Windows 에서 npx(.cmd) 를 shell 없이 spawn → EINVAL → 전 항목 FAIL
const command = check.command ?? 'npx';
const args = check.args ?? ['tsx', join(here, `${check.name}.ts`)];
const res = spawnSync(command, args, { stdio: 'inherit' });

// After — tsx 의 JS CLI 를 node 로 직접 실행. 셸·이스케이프·플랫폼 분기 모두 불필요.
const TSX_CLI = createRequire(import.meta.url).resolve('tsx/cli');
const res = check.shellCommand
  ? spawnSync(check.shellCommand, { stdio: 'inherit', shell: true })   // 공백 없는 리터럴 한 줄만
  : spawnSync(process.execPath, [TSX_CLI, join(here, `${check.name}.ts`)], { stdio: 'inherit' });
```

### PR
(브랜치 `fix/28-zoomto-frames-octree-cube` 에 동승 — 파일이 겹치지 않아 커밋은 분리 가능)

---

## 5. 검증 결과

### 테스트 방법
러너 자체가 재현 도구다. `npm test`(오프라인 9)와 `npm run test:integration`(S3 네트워크 9)을 그대로 실행해
집계 결과와 개별 실행 결과가 일치하는지 본다. 1차안(`shell:true` + 인자 배열)은 Node 폐기예정 경고
(DEP0190) 출력 여부로 기각을 판정했다.

### 결과
| 항목 | 수정 전 | 수정 후 | 판정 |
|------|---------|---------|------|
| `npm test` (Windows) | **0/9** | **9/9 ALL PASS ✅** | PASS |
| `npm run test:integration` (Windows) | 실행 불가(동일 결함) | **9/9 ALL PASS ✅** | PASS |
| 개별 체크 9종 (대조군) | 9/9 | 9/9 | 일치 |
| Node DEP0190 경고 | — | **없음** | PASS |
| `tsc --noEmit` | 통과 | 통과 | 회귀 없음 |

1차안(인자 배열 + `shell:true`)도 9/9 를 냈으나 DEP0190 경고가 떠서 채택하지 않고 node 직접 실행으로 바꿨다.

### 잔여 이슈
- `scripts/bench/fair-compare.ts:46` 의 `spawn('npx', ['vite', …])` 도 Windows 에서 같은 이유로 `EINVAL` 이다.
  본 이슈 범위(집계 러너) 밖이고 벤치 도구라 회귀 가드가 아니므로 **미수정**. 필요 시 별도 이슈로 등록한다.
  (같은 패턴: `node node_modules/vite/bin/vite.js` 로 바꾸면 해결)

---

## 부록 — 같은 뿌리의 Windows spawn 결함 (참고)

이 이슈와 동일하게 `.cmd` 셰임을 spawn 해 Windows 에서 실패하는 곳:

| 위치 | 상태 |
|------|------|
| `scripts/run-checks.ts` | **수정됨** (본 이슈) |
| `scripts/bench/fair-compare.ts:46` `spawn('npx', ['vite', …])` | 미수정 — 벤치 도구, 회귀 가드 아님 |

회피 패턴(세션 중 실증): `spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--port', '5173'])`
