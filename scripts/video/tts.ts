// 나레이션 합성 — edge-tts(한국어 뉴럴). 구간별 mp3 를 만들고 실제 길이를 잰다.
// 타이밍의 주인은 나레이션이다. build.ts 는 여기서 나온 길이에 화면을 맞춘다.
//
// 사용: tsx scripts/video/tts.ts [--rate=+8%]
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { SECTIONS } from './sections';

export const VOICE = 'ko-KR-InJoonNeural';
export const AUDIO_DIR = 'docs/submission/video/assets/audio';
const RATE = process.argv.find((a) => a.startsWith('--rate='))?.slice(7) ?? '+8%';

export function ffprobePath(): string {
  for (const c of ['ffprobe', join(process.env.LOCALAPPDATA ?? '', 'Microsoft/WinGet/Links/ffprobe.exe')]) {
    if (spawnSync(c, ['-version'], { stdio: 'ignore' }).status === 0) return c;
  }
  throw new Error('ffprobe 를 찾지 못했다');
}

export function durationOf(ffprobe: string, file: string): number {
  const r = spawnSync(ffprobe, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', file], {
    encoding: 'utf8',
  });
  const d = Number(String(r.stdout).trim());
  if (!Number.isFinite(d) || d <= 0) throw new Error(`길이를 못 읽었다: ${file}`);
  return d;
}

export function audioPath(id: string): string {
  return join(AUDIO_DIR, `${id}.mp3`);
}

async function main() {
  mkdirSync(AUDIO_DIR, { recursive: true });
  const ffprobe = ffprobePath();
  const rows: { id: string; secs: number; chars: number }[] = [];

  for (const s of SECTIONS) {
    const out = audioPath(s.id);
    // edge-tts 는 파이썬 모듈로 호출(.cmd 셰임 회피 — 이슈 #29 와 같은 이유).
    const r = spawnSync(
      'python',
      ['-m', 'edge_tts', '--voice', VOICE, '--rate', RATE, '--text', s.narration, '--write-media', out],
      { stdio: ['ignore', 'ignore', 'inherit'] },
    );
    if (r.status !== 0 || !existsSync(out)) throw new Error(`${s.id}: TTS 실패`);
    const secs = durationOf(ffprobe, out);
    rows.push({ id: s.id, secs, chars: s.narration.length });
    console.log(`  ${s.id.padEnd(18)} ${secs.toFixed(2)}s   (${s.narration.length}자)`);
  }

  const total = rows.reduce((a, r) => a + r.secs, 0);
  console.log(`\n합계 ${total.toFixed(1)}s  (${Math.floor(total / 60)}분 ${(total % 60).toFixed(0)}초)  voice=${VOICE} rate=${RATE}`);
  writeFileSync(
    join(AUDIO_DIR, 'durations.json'),
    JSON.stringify({ voice: VOICE, rate: RATE, total, sections: rows }, null, 2),
  );
}

main().catch((e) => {
  console.error('[tts] fatal', e);
  process.exit(1);
});
