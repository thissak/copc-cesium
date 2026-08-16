import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { scenes } from '../../docs/submission/video/composition/timeline.js';

const projectRoot = resolve(import.meta.dirname, '../..');
const outputDir = resolve(projectRoot, 'docs/submission/video/assets/audio/raw');
const ffprobe =
  process.env.FFPROBE ??
  '/private/tmp/copc-video-tools/node_modules/ffprobe-static/bin/darwin/arm64/ffprobe';
const rate = process.env.SAY_RATE ?? '185';

await mkdir(outputDir, { recursive: true });
const metadata = [];

for (const [index, scene] of scenes.entries()) {
  const id = String(index + 1).padStart(2, '0');
  const output = resolve(outputDir, `${id}-${scene.id}.aiff`);
  const result = spawnSync('say', ['-v', 'Yuna', '-r', rate, '-o', output, scene.narration], {
    encoding: 'utf8',
  });
  if (result.status !== 0) throw new Error(result.stderr || `say failed: ${scene.id}`);

  const probe = spawnSync(
    ffprobe,
    ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', output],
    { encoding: 'utf8' },
  );
  if (probe.status !== 0) throw new Error(probe.stderr || `ffprobe failed: ${scene.id}`);
  metadata.push({
    id: scene.id,
    allottedSeconds: scene.duration,
    narrationSeconds: Number(Number(probe.stdout.trim()).toFixed(3)),
    file: output,
  });
}

await writeFile(
  resolve(outputDir, 'metadata.json'),
  JSON.stringify({ voice: 'Yuna', rate, scenes: metadata }, null, 2) + '\n',
);
console.table(metadata.map(({ id, allottedSeconds, narrationSeconds }) => ({ id, allottedSeconds, narrationSeconds })));
