// 나레이션 오디오 검사 — 외부 TTS(Typecast·Clova 등)나 사람 녹음으로 만든 파일이
// timeline.js 의 씬 길이와 맞는지 확인한다.
//
// 왜 필요한가: render-final.mjs 가 씬별 오디오를 `apad → atrim=0:duration` 으로 처리한다.
// 오디오가 timeline 의 duration 보다 길면 **말끝이 잘린 채** 최종본이 나온다.
// 그래서 순서가 중요하다 — 먼저 나레이션을 만들고, 이 스크립트로 실측한 뒤,
// 그 값에 여유를 더해 timeline.js 의 duration 을 채운다.
//
// 사용법:
//   1) 씬별 오디오를 docs/submission/video/assets/audio/raw/ 에 넣는다
//      파일명 규칙: 01-hero.wav, 02-problem.wav … (번호 = timeline 순서, 이름 = scene.id)
//   2) node scripts/video/check-narration.mjs
//
// 확장자는 wav·mp3·m4a·aiff 를 받는다. ffprobe 는 PATH → FFPROBE 환경변수 →
// ffprobe-static 순으로 찾는다.
import { readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { scenes } from '../../docs/submission/video/composition/timeline.js';

const projectRoot = resolve(import.meta.dirname, '../..');
const audioDir = resolve(projectRoot, 'docs/submission/video/assets/audio/raw');
const EXTS = ['.wav', '.mp3', '.m4a', '.aiff'];
const HEADROOM = 0.3; // 씬 길이는 오디오보다 최소 이만큼 길어야 안전하다 (초)

function resolveFfprobe() {
  if (process.env.FFPROBE) return process.env.FFPROBE;
  if (spawnSync('ffprobe', ['-version'], { encoding: 'utf8' }).status === 0) return 'ffprobe';
  throw new Error(
    'ffprobe 를 찾을 수 없다. PATH 에 두거나 FFPROBE 환경변수로 경로를 주거나 `npm i ffprobe-static` 후 그 경로를 지정할 것.',
  );
}

function durationOf(ffprobe, file) {
  const probe = spawnSync(
    ffprobe,
    ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', file],
    { encoding: 'utf8' },
  );
  if (probe.status !== 0) throw new Error(probe.stderr || `ffprobe 실패: ${file}`);
  const seconds = Number(probe.stdout.trim());
  if (!Number.isFinite(seconds)) throw new Error(`길이를 읽을 수 없다: ${file}`);
  return seconds;
}

const ffprobe = resolveFfprobe();
let files = [];
try {
  files = await readdir(audioDir);
} catch {
  throw new Error(`나레이션 디렉터리가 없다: ${audioDir}\n씬별 오디오를 먼저 넣을 것.`);
}

const rows = [];
const problems = [];

for (const [index, scene] of scenes.entries()) {
  const prefix = `${String(index + 1).padStart(2, '0')}-${scene.id}`;
  const match = files.find((f) => EXTS.some((e) => f === prefix + e));
  if (!match) {
    problems.push(`${prefix}: 오디오 파일 없음 (${EXTS.join('|')} 중 하나)`);
    rows.push({ scene: prefix, timeline: scene.duration, audio: null, verdict: 'MISSING' });
    continue;
  }
  const audio = Number(durationOf(ffprobe, resolve(audioDir, match)).toFixed(3));
  const slack = Number((scene.duration - audio).toFixed(3));
  let verdict = 'OK';
  if (slack < 0) {
    verdict = 'TRUNCATED';
    problems.push(
      `${prefix}: 오디오 ${audio}s > 씬 ${scene.duration}s → 최종본에서 ${Math.abs(slack)}s 가 잘린다`,
    );
  } else if (slack < HEADROOM) {
    verdict = 'TIGHT';
    problems.push(`${prefix}: 여유 ${slack}s (권장 ${HEADROOM}s 이상) — 씬 길이를 늘릴 것`);
  }
  rows.push({ scene: prefix, timeline: scene.duration, audio, slack, verdict });
}

console.table(rows);
const total = rows.reduce((s, r) => s + (r.audio ?? 0), 0);
console.log(
  `나레이션 합계 ${total.toFixed(1)}s · timeline 합계 ${scenes.reduce((s, x) => s + x.duration, 0)}s`,
);

if (problems.length > 0) {
  console.error('\n문제 ' + problems.length + '건:');
  for (const p of problems) console.error(' - ' + p);
  process.exit(1);
}
console.log('\n모든 씬 길이가 나레이션을 담을 수 있다.');
