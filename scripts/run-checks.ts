// 헤드리스 체크 스크립트들을 한 진입점에서 순차 실행하고 결과를 집계한다.
// 실행:
//   npm test               → unit 스위트 (오프라인 결정적)
//   npm run test:integration → integration 스위트 (S3 range 네트워크 필요)
//   npm run test:all         → 둘 다
//
// 각 check-*.ts / verify.ts 는 PASS 시 exit 0, FAIL 시 exit 1 을 이미 낸다.
// 이 러너는 그 계약을 모아 한 번의 PASS/FAIL 로 환원한다 (테스트 프레임워크 도입 없이).
// (이슈 #20 재현 check-cancel 은 won't-fix 실증 도구라 회귀 가드가 아니므로 제외.)

import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
// npx/npm 은 Windows 에서 .cmd 셰임이라 shell 없이 spawn 하면 EINVAL 로 거부된다(Node 공식 문서:
// "Spawning .bat and .cmd files on Windows"). tsx 의 CLI 는 순수 JS 라 node 로 직접 실행하면
// 셸이 아예 필요 없다 — 크로스플랫폼이고 인자 이스케이프 문제도 없다 (이슈 #29).
const TSX_CLI = createRequire(import.meta.url).resolve('tsx/cli');

interface Check {
  name: string;
  /** 셸 한 줄로 실행할 명령(공백 인자 없는 리터럴만). 없으면 node + tsx 로 직접 실행. */
  shellCommand?: string;
}
const tsx = (name: string): Check => ({ name });

// 오프라인 결정적 — 네트워크 없이 항상 재현 (심사 환경 안전)
const UNIT: Check[] = [
  'check-crs',
  'check-ecef',
  'check-picking',
  'check-pnts-batch',
  'check-style',
  'check-request-throttle',
  'check-sw-routing',
  'check-cesium-codec',
].map(tsx);
// tsc 플래그의 SSOT 는 package.json 이므로 npm 스크립트를 그대로 부른다. 인자에 공백이 없어
// 단일 문자열 + shell 로 안전하게 실행된다(인자 배열 + shell 조합은 Node DEP0190 폐기 대상).
UNIT.push({ name: 'check-public-types', shellCommand: 'npm run check:public-types' });

// S3 range 네트워크 필요 — 전체 파이프라인 통합 검증
const INTEGRATION: Check[] = [
  'verify',
  'check-attributes',
  'check-attr-pipeline',
  'check-classification',
  'check-coalesce',
  'check-hierarchy',
  'check-paging',
  'check-retry',
  'check-snap',
].map(tsx);

const SUITES: Record<string, Check[]> = {
  unit: UNIT,
  integration: INTEGRATION,
  all: [...UNIT, ...INTEGRATION],
};

const suiteName = process.argv[2] ?? 'unit';
const names = SUITES[suiteName];
if (!names) {
  console.error(`unknown suite "${suiteName}" — use one of: ${Object.keys(SUITES).join(' | ')}`);
  process.exit(2);
}

console.log(`\n▶ running "${suiteName}" suite — ${names.length} checks\n`);

const failed: string[] = [];
for (const check of names) {
  console.log(`────────────  ${check.name}  ────────────`);
  const res = check.shellCommand
    ? spawnSync(check.shellCommand, { stdio: 'inherit', shell: true })
    : spawnSync(process.execPath, [TSX_CLI, join(here, `${check.name}.ts`)], { stdio: 'inherit' });
  if (res.status !== 0) failed.push(check.name);
  console.log('');
}

const passed = names.length - failed.length;
console.log('='.repeat(44));
console.log(`${passed}/${names.length} passed`);
if (failed.length) {
  console.log(`FAIL ❌  ${failed.join(', ')}`);
  process.exit(1);
}
console.log('ALL PASS ✅');
