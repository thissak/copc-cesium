import { mkdir, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { scenes, totalDuration } from '../../docs/submission/video/composition/timeline.js';

const projectRoot = resolve(import.meta.dirname, '../..');
// 바이너리는 환경변수 → PATH 순으로 찾는다. 특정 OS 경로를 박으면 다른 머신에서 못 돈다.
function resolveBin(envKey, name) {
  if (process.env[envKey]) return process.env[envKey];
  if (spawnSync(name, ['-version'], { encoding: 'utf8' }).status === 0) return name;
  throw new Error(
    `${name} 을 찾을 수 없다. PATH 에 두거나 ${envKey} 환경변수로 경로를 줄 것 ` +
      '(`npm i ffmpeg-static ffprobe-static` 로 받은 경로도 된다).',
  );
}
const ffmpeg = resolveBin('FFMPEG', 'ffmpeg');
const ffprobe = resolveBin('FFPROBE', 'ffprobe');
const audioDir = resolve(projectRoot, 'docs/submission/video/assets/audio/raw');
const renderDir = resolve(projectRoot, 'docs/submission/video/assets/render');
const outputDir = resolve(projectRoot, 'docs/submission/video/output');
const visualMaster = resolve(renderDir, 'visual-master.webm');
const narrationMaster = resolve(renderDir, 'narration-master.wav');
const finalOutput = resolve(outputDir, 'copc-cesium-demo-v1.mp4');

await mkdir(renderDir, { recursive: true });
await mkdir(outputDir, { recursive: true });

// 나레이션은 외부 TTS(Typecast·Clova 등) 산출물이라 확장자가 고정되지 않는다.
// 길이 정합은 scripts/video/check-narration.mjs 로 먼저 확인할 것 — 씬보다 긴 오디오는 잘린다.
const AUDIO_EXTS = ['.wav', '.mp3', '.m4a', '.aiff'];
const audioFiles = await readdir(audioDir).catch(() => {
  throw new Error(`나레이션 디렉터리가 없다: ${audioDir}`);
});
const narrationInputs = scenes.flatMap((scene, index) => {
  const prefix = `${String(index + 1).padStart(2, '0')}-${scene.id}`;
  const match = audioFiles.find((f) => AUDIO_EXTS.some((e) => f === prefix + e));
  if (!match) throw new Error(`나레이션 오디오 없음: ${prefix} (${AUDIO_EXTS.join('|')})`);
  return ['-i', resolve(audioDir, match)];
});
const pads = scenes.map(
  (scene, index) =>
    `[${index}:a]aresample=48000,apad=pad_dur=${scene.duration},` +
    `atrim=0:${scene.duration},asetpts=PTS-STARTPTS[a${index}]`,
);
const concatInputs = scenes.map((_, index) => `[a${index}]`).join('');
const audioFilter = `${pads.join(';')};${concatInputs}concat=n=${scenes.length}:v=0:a=1,` +
  'loudnorm=I=-16:LRA=7:TP=-1.5[narration]';

let result = spawnSync(
  ffmpeg,
  [
    '-y',
    ...narrationInputs,
    '-filter_complex',
    audioFilter,
    '-map',
    '[narration]',
    '-c:a',
    'pcm_s16le',
    narrationMaster,
  ],
  { encoding: 'utf8' },
);
if (result.status !== 0) throw new Error(result.stderr || 'narration render failed');

const probe = spawnSync(
  ffprobe,
  ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', visualMaster],
  { encoding: 'utf8' },
);
if (probe.status !== 0) throw new Error(probe.stderr || 'visual probe failed');
const recordedDuration = Number(probe.stdout.trim());
const visualStart = Math.max(0, recordedDuration - totalDuration);

result = spawnSync(
  ffmpeg,
  [
    '-y',
    '-ss',
    visualStart.toFixed(3),
    '-i',
    visualMaster,
    '-i',
    narrationMaster,
    '-t',
    String(totalDuration),
    '-map',
    '0:v:0',
    '-map',
    '1:a:0',
    '-vf',
    'fps=30,format=yuv420p',
    '-c:v',
    'libx264',
    '-preset',
    'medium',
    '-crf',
    '18',
    '-c:a',
    'aac',
    '-b:a',
    '192k',
    '-ar',
    '48000',
    '-ac',
    '2',
    '-movflags',
    '+faststart',
    finalOutput,
  ],
  { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 },
);
if (result.status !== 0) throw new Error(result.stderr || 'final MP4 render failed');

console.log(JSON.stringify({ finalOutput, totalDuration, recordedDuration, visualStart }, null, 2));
