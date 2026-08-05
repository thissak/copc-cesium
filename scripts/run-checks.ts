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
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

interface Check {
  name: string;
  command?: string;
  args?: string[];
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
UNIT.push({ name: 'check-public-types', command: 'npm', args: ['run', 'check:public-types'] });

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
  const command = check.command ?? 'npx';
  const args = check.args ?? ['tsx', join(here, `${check.name}.ts`)];
  const res = spawnSync(command, args, { stdio: 'inherit' });
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
