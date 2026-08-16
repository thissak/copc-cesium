import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { scenes, totalDuration } from '../../docs/submission/video/composition/timeline.js';

const projectRoot = resolve(import.meta.dirname, '../..');
const ffmpeg =
  process.env.FFMPEG ?? '/private/tmp/copc-video-tools/node_modules/ffmpeg-static/ffmpeg';
const ffprobe =
  process.env.FFPROBE ??
  '/private/tmp/copc-video-tools/node_modules/ffprobe-static/bin/darwin/arm64/ffprobe';
const audioDir = resolve(projectRoot, 'docs/submission/video/assets/audio/raw');
const renderDir = resolve(projectRoot, 'docs/submission/video/assets/render');
const outputDir = resolve(projectRoot, 'docs/submission/video/output');
const visualMaster = resolve(renderDir, 'visual-master.webm');
const narrationMaster = resolve(renderDir, 'narration-master.wav');
const finalOutput = resolve(outputDir, 'copc-cesium-demo-v1.mp4');

await mkdir(renderDir, { recursive: true });
await mkdir(outputDir, { recursive: true });

const narrationInputs = scenes.flatMap((scene, index) => [
  '-i',
  resolve(audioDir, `${String(index + 1).padStart(2, '0')}-${scene.id}.aiff`),
]);
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
