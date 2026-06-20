// scripts/bench/fair-report.ts
import type { ViewerCurve, ValidityGates } from './fair-types';

interface ReportArg { ds: string; ours: ViewerCurve; eptium: ViewerCurve; verdict: any[]; floor: number; gates: ValidityGates; nullOk: boolean }

export function renderFairReport(a: ReportArg): string {
  const L: string[] = [];
  L.push(`# Fair Engine Bench — ${a.ds}`, '');
  L.push(`> 로딩 곡선 샘플링 · 동일 config · 고정 시점 · cost=GPU 타이머 GPU ms. 노이즈바닥=${(a.floor * 100).toFixed(1)}%`, '');
  const allPass = Object.values(a.gates).every(Boolean);
  L.push(`## 유효성 게이트: ${allPass ? '✅ 전부 PASS' : '❌ 일부 FAIL → verdict 신뢰불가'}`, '');
  for (const [k, v] of Object.entries(a.gates)) L.push(`- ${v ? '✅' : '❌'} ${k}`);
  L.push('', `## Verdict ${allPass ? '' : '(신뢰불가 — 게이트 실패)'} — 공통 점 버킷별 GPU ms`, '');
  if (!a.verdict.length) L.push('_겹치는 점 버킷 없음 — 비교 불가_');
  else {
    L.push('| 점 버킷 | ours GPU ms | eptium GPU ms | ratio | 판정 |', '|---|---|---|---|---|');
    for (const v of a.verdict) L.push(`| ${v.pts.toLocaleString()} | ${v.oursGpuMs} | ${v.eptiumGpuMs} | ${v.ratio} | ${v.verdict} |`);
  }
  L.push('', '## 곡선 (GPU ms @ pointsSelected)', '');
  for (const r of [a.ours, a.eptium]) {
    L.push(`**${r.label}** (${r.glRenderer}) gpuOk=${r.gpuOk} finalPts=${r.finalPts.toLocaleString()}`);
    L.push('| 점 버킷 | GPU ms median | n |', '|---|---|---|');
    for (const p of r.curve) L.push(`| ${p.pts.toLocaleString()} | ${p.gpuMs} | ${p.n} |`);
    L.push('');
  }
  L.push(`## 영실험 (ours-vs-ours)`, '', a.nullOk ? '✅ ours-vs-ours = 동급 → 도구 무편향 확인' : '❌ ours-vs-ours ≠ 동급 → 도구 편향/노이즈, verdict 불신', '');
  return L.join('\n');
}
