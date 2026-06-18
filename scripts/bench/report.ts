import type { BenchResult, BenchMeta } from './types';

export function pctDelta(ours: number, base: number): string {
  if (!base) return 'n/a';
  const d = ((ours - base) / base) * 100;
  return (d >= 0 ? '+' : '') + d.toFixed(0) + '%';
}

export function renderReport(ours: BenchResult, eptium: BenchResult, meta: BenchMeta): string {
  const row = (
    name: string,
    pick: (r: BenchResult) => number,
    fmt: (n: number) => string = (n) => String(n),
  ) => `| ${name} | ${fmt(pick(ours))} | ${fmt(pick(eptium))} | ${pctDelta(pick(ours), pick(eptium))} |`;

  const mb = (n: number) => (n / 1048576).toFixed(1) + ' MB';
  const ms = (n: number) => n.toFixed(0) + ' ms';

  const lines: string[] = [];
  lines.push(`# Eptium 오라클 벤치 — ${meta.dataset}`);
  lines.push('');
  lines.push(
    `> 측정 ${meta.timestamp} · 데이터 \`${meta.dataset}\` · **msse=${meta.msse}** · 스트레스 ${meta.secs}s · 네트워크 ${meta.throttle}`,
  );
  lines.push(
    `> 우리 GL: \`${ours.glRenderer}\` · Eptium GL: \`${eptium.glRenderer}\``,
  );
  lines.push('');
  lines.push('## 품질 정규화 증인 (이게 안 맞으면 아래 비교 무효)');
  lines.push('');
  lines.push('| 증인 | ours | eptium |');
  lines.push('|------|------|--------|');
  lines.push(`| msse | ${ours.msse} | ${eptium.msse} |`);
  lines.push(`| numberOfPointsSelected | ${ours.pointsSelected.toLocaleString('en-US')} | ${eptium.pointsSelected.toLocaleString('en-US')} |`);
  lines.push(`| tilesReady / total | ${ours.tilesReady}/${ours.tilesTotal} | ${eptium.tilesReady}/${eptium.tilesTotal} |`);
  lines.push('');
  lines.push('## Tier 1a — 북극성 (재현·자동, 낮을수록 좋음 ↓)');
  lines.push('');
  lines.push('| 지표 | ours | eptium | Δ(ours vs eptium) |');
  lines.push('|------|------|--------|-------------------|');
  lines.push(row('TTD 풀레솔 도달', (r) => r.ttdMs, ms));
  lines.push(row('네트워크 bytes', (r) => r.bytesTotal, mb));
  lines.push(row('range 요청 수', (r) => r.reqCount));
  lines.push(row('peak heap', (r) => r.peakHeapMB, (n) => n.toFixed(0) + ' MB'));
  lines.push('');
  lines.push('## Tier 1b — 부드러움 보조 (frametime, 낮을수록 좋음 ↓)');
  lines.push('');
  lines.push('| 지표 | ours | eptium | Δ |');
  lines.push('|------|------|--------|---|');
  lines.push(row('frametime p50', (r) => r.frametimeMs.p50, ms));
  lines.push(row('frametime p95', (r) => r.frametimeMs.p95, ms));
  lines.push(row('hitch >50ms 수', (r) => r.hitchesGt50));
  lines.push(row('longTask 합(ms)', (r) => r.longTaskTotalMs, ms));
  lines.push('');
  lines.push('## Tier 2 — fps (실GPU headed, 보조; headless면 무효)');
  lines.push('');
  lines.push(`fps≈1000/p50 — ours **${ours.fpsFromP50}** · eptium **${eptium.fpsFromP50}**. 자동화 브라우저 fps라 2급. headless swiftshader면 이 줄 무시.`);
  lines.push('');
  // Surface measurement limitations (no silent failures)
  const ptsDivergePct = eptium.pointsSelected > 0
    ? Math.abs((ours.pointsSelected - eptium.pointsSelected) / eptium.pointsSelected) * 100
    : 0;
  const hasLimits = !ours.ok || !eptium.ok || ours.msse !== eptium.msse || ptsDivergePct > 15;
  if (hasLimits) {
    lines.push('## ⚠️ 측정 한계');
    if (!ours.ok) lines.push(`- ours 실패: ${ours.error}`);
    if (!eptium.ok) lines.push(`- eptium 실패: ${eptium.error}`);
    if (ours.msse !== eptium.msse) {
      lines.push(`- msse 불일치: ours=${ours.msse} vs eptium=${eptium.msse}. Cesium의 msse=32는 full-cloud 거리에서 타일 0개를 요청(허용 SSE가 너무 크다). ours는 자연값 msse=8로 측정. 직접 비교 시 이 차이 감안 필요.`);
    }
    if (ptsDivergePct > 15) {
      lines.push(`- numberOfPointsSelected 큰 차이: ours=${ours.pointsSelected.toLocaleString('en-US')} vs eptium=${eptium.pointsSelected.toLocaleString('en-US')} (${ptsDivergePct.toFixed(0)}% 차). msse 정규화가 품질을 동등하게 맞추지 못함. 1a 비교는 참고용.`);
    }
    lines.push(`- ours reqCount/bytesTotal은 main-thread S3 요청만 집계(헤더 3회). 타일 content는 Web Worker→SW 경유 S3 range 요청이라 CDPSession에서 보이지 않음.`);
    lines.push('');
  }
  return lines.join('\n');
}
