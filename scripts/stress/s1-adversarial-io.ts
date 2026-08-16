// S1 — 적대적 IO 스트레스: "나쁜 서버" 앞에서 우리 IO 계층이 어떻게 실패하는가.
//
// 두 국면으로 나눈다. 결함 창을 파일 전체에 걸면 헤더 파싱에서 다 걸려 **디코드 경로가 안 뚫린다**.
//   Phase A (open)   : 결함 창 = 파일 전체        → 헤더/하이어라키 읽기의 실패 품질
//   Phase B (decode) : 결함 창 = 점데이터 구간만  → 타일 디코드 경로의 실패 품질 (coalesce off/on)
//
// 판정 기준(중요도 순):
//   SILENT   = 손상된 바이트인데 예외 없이 점을 반환 → **최악**(쓰레기를 렌더)
//   HANG     = 제한 시간 내 결과도 예외도 없음      → 사용자 화면 영구 멈춤
//   UNCLEAR  = 실패는 하는데 메시지가 원인을 안 가리킴 → 운영 시 진단 불가
//   LOUD     = 명확한 메시지로 실패                  → 기대 동작
//   OK       = 정상 통과 (통제군 / 재시도 복구)
//
// 실행: npx tsx scripts/stress/s1-adversarial-io.ts <local.copc.laz>
import { Copc } from 'copc';
import { openCopc, decodeNode, httpGetterWithRetry, type CoalesceOpts } from '../../src/copc-core';
import { startFaultServer, type FaultMode } from './fault-server';

const file = process.argv[2];
if (!file) {
  console.error('usage: tsx scripts/stress/s1-adversarial-io.ts <path/to/file.copc.laz>');
  process.exit(2);
}

const CASE_TIMEOUT_MS = 90_000;
const ROOT = '0-0-0-0';
const COALESCE: CoalesceOpts = { maxGap: 256 * 1024, maxBytes: 8 * 1024 * 1024, cacheBytes: 64 * 1024 * 1024 };

interface Outcome {
  phase: 'A-open' | 'B-decode' | 'B-decode+coalesce';
  mode: FaultMode;
  verdict: 'OK' | 'LOUD' | 'UNCLEAR' | 'SILENT' | 'HANG';
  stage: 'open' | 'decode' | 'done';
  ms: number;
  points?: number;
  checksum?: number;
  peakHeapMB: number;
  message?: string;
}

/** 좌표 가중합 — 통제군과 다르면 같은 바이트를 다르게 읽은 것. */
function checksum(lonLatH: number[]): number {
  let s = 0;
  for (let i = 0; i < lonLatH.length; i++) s = (s + lonLatH[i] * (i + 1)) % 1e12;
  return Math.round(s * 1e3) / 1e3;
}

/** 원인을 가리키는 메시지인가 — 아니면 "undefined 읽기" 류의 내부 폭발인가. */
function isClear(msg: string): boolean {
  const clear = /HTTP \d{3}|range|Range|timeout|timed out|abort|CRS|COPC|LAZ|laz|chunk|header|signature|hierarchy|point|truncat|byte/i;
  const opaque = /Cannot read propert|undefined is not|is not a function|out of bounds|RangeError: Offset|Cannot convert|NaN|memory access/i;
  return clear.test(msg) && !opaque.test(msg);
}

type Raced<T> = { t: 'v'; v: T } | { t: 'e'; e: unknown } | { t: 'timeout' };
async function withTimeout<T>(p: Promise<T>, ms: number): Promise<Raced<T>> {
  let timer: NodeJS.Timeout | undefined;
  const to = new Promise<{ t: 'timeout' }>((r) => {
    timer = setTimeout(() => r({ t: 'timeout' }), ms);
  });
  try {
    return await Promise.race([p.then((v) => ({ t: 'v' as const, v })).catch((e) => ({ t: 'e' as const, e })), to]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

const msgOf = (e: unknown) => (e as Error)?.message ?? String(e);

async function runCase(url: string, mode: FaultMode, phase: Outcome['phase'], coalesce?: CoalesceOpts): Promise<Outcome> {
  const t0 = Date.now();
  let peak = process.memoryUsage().heapUsed;
  const poll = setInterval(() => {
    peak = Math.max(peak, process.memoryUsage().heapUsed);
  }, 50);
  const fin = (o: Omit<Outcome, 'phase' | 'mode' | 'ms' | 'peakHeapMB'>): Outcome => {
    clearInterval(poll);
    return { phase, mode, ms: Date.now() - t0, peakHeapMB: Math.round((peak / 1048576) * 10) / 10, ...o };
  };

  const opened = await withTimeout(openCopc(url, coalesce ? { coalesce } : undefined), CASE_TIMEOUT_MS);
  if (opened.t === 'timeout') return fin({ verdict: 'HANG', stage: 'open' });
  if (opened.t === 'e') {
    const msg = msgOf(opened.e);
    return fin({ verdict: isClear(msg) ? 'LOUD' : 'UNCLEAR', stage: 'open', message: msg });
  }

  const decoded = await withTimeout(decodeNode(opened.v, ROOT, undefined, 'rgb'), CASE_TIMEOUT_MS);
  if (decoded.t === 'timeout') return fin({ verdict: 'HANG', stage: 'decode' });
  if (decoded.t === 'e') {
    const msg = msgOf(decoded.e);
    return fin({ verdict: isClear(msg) ? 'LOUD' : 'UNCLEAR', stage: 'decode', message: msg });
  }
  const r = decoded.v;
  return fin({ verdict: 'OK', stage: 'done', points: r?.count ?? 0, checksum: r ? checksum(r.lonLatH) : undefined });
}

const srv = await startFaultServer(file);
// 결함 창을 점데이터 구간으로 좁히려면 파일 레이아웃이 필요하다 — 정상 경로로 한 번 읽는다.
const clean = await Copc.create(httpGetterWithRetry(srv.url('ok')));
const HEADER_READ = 65_536; // copc.js 가 헤더+VLR 을 한 번에 읽는 창
// 하이어라키 EVLR 은 pageOffset **직전** 60바이트 헤더부터 읽힌다 → 여유를 두고 창을 닫는다.
const POINT_SCOPE = { from: HEADER_READ + 1, to: clean.info.rootHierarchyPage.pageOffset - HEADER_READ };
console.log(`fault server: ${srv.base}  size=${srv.size}  point-data 결함창=[${POINT_SCOPE.from}, ${POINT_SCOPE.to})\n`);

const results: Outcome[] = [];
let control: Outcome | undefined;

async function phase(
  name: Outcome['phase'],
  modes: FaultMode[],
  scope: { from: number; to: number } | undefined,
  coalesce?: CoalesceOpts,
) {
  console.log(`── ${name} ${scope ? '(점데이터 구간만 손상)' : '(파일 전체 손상)'}${coalesce ? ' +coalesce' : ''} ──`);
  for (const mode of modes) {
    process.stdout.write(`  ${mode.padEnd(10)} … `);
    const o = await runCase(srv.url(mode, scope), mode, name, coalesce);
    // 손상 모드가 "OK" 로 끝났다면 통제군과 대조해 조용한 오염인지 가른다.
    if (o.verdict === 'OK' && control && (o.checksum !== control.checksum || o.points !== control.points)) {
      o.verdict = 'SILENT';
    }
    if (mode === 'ok' && !control) control = o;
    results.push(o);
    console.log(
      `${o.verdict.padEnd(8)} ${String(o.ms).padStart(6)}ms  heap ${String(o.peakHeapMB).padStart(6)}MB` +
        (o.points !== undefined ? `  pts ${o.points}` : '') +
        (o.message ? `\n             ↳ ${o.message.slice(0, 170)}` : ''),
    );
  }
  console.log('');
}

const OPEN_MODES: FaultMode[] = ['ok', 'flaky', 'always403', 'always500', 'zero', 'short', 'shift', 'corrupt', 'norange', 'slow'];
const DECODE_MODES: FaultMode[] = ['zero', 'short', 'shift', 'corrupt', 'norange', 'always500', 'flaky'];

await phase('A-open', OPEN_MODES, undefined);
await phase('B-decode', DECODE_MODES, POINT_SCOPE);
await phase('B-decode+coalesce', DECODE_MODES, POINT_SCOPE, COALESCE);

await srv.close();

// shift/corrupt 는 공개된 고유 한계(LAZ 에 청크 체크섬 없음 — 실패는 하나 메시지가 불친절) → 게이트 실패로 안 센다.
const KNOWN_UNCLEAR = new Set<FaultMode>(['shift', 'corrupt']);
const known = results.filter((r) => r.verdict === 'UNCLEAR' && KNOWN_UNCLEAR.has(r.mode));
const bad = results.filter((r) => r.verdict === 'SILENT' || r.verdict === 'HANG' || (r.verdict === 'UNCLEAR' && !KNOWN_UNCLEAR.has(r.mode)));
console.log('── 요약 ──');
console.log(
  JSON.stringify(
    results.map(({ phase, mode, verdict, stage, ms, points, peakHeapMB, message }) => ({ phase, mode, verdict, stage, ms, points, peakHeapMB, message })),
    null,
    1,
  ),
);
if (bad.length) {
  console.log(`\n결함 후보 ${bad.length}건:\n${bad.map((b) => `  ${b.phase}/${b.mode} = ${b.verdict}  ${b.message ?? `pts=${b.points}`}`).join('\n')}`);
}
if (known.length) {
  console.log(`\n알려진 한계 ${known.length}건 (게이트 제외):\n${known.map((k) => `  ${k.phase}/${k.mode} = ${k.verdict}  ${k.message ?? `pts=${k.points}`}`).join('\n')}`);
}
if (bad.length) process.exit(1);
console.log('\n모든 모드가 명확히 실패하거나 정상 통과 — 결함 후보 0');
