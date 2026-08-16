// 최종 영상 합성 — 나레이션 길이에 화면을 맞춰 구간을 만들고 이어붙인다.
//
// 타이밍의 주인은 나레이션이다. 구간 길이 = 나레이션 길이 + GAP(호흡).
// 오디오도 같은 길이로 패딩하므로 이어붙이기만 하면 A/V 가 자동으로 맞는다.
//
// 사용:
//   npm run dev                       # 자막·카드 렌더에 브라우저만 쓰므로 dev 서버는 불필요
//   tsx scripts/video/tts.ts          # 1) 나레이션 먼저
//   tsx scripts/video/build.ts        # 2) 합성
//
// 출력: docs/submission/video/copc-cesium-demo.mp4 (1920×1080 · 30fps · H.264/AAC)
import { chromium, type Page } from 'playwright';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { SECTIONS, type Section } from './sections';
import { CARDS, terminalPage, W, H } from './cards';
import { audioPath, durationOf, ffprobePath } from './tts';

const RAW = 'docs/submission/video/assets/raw';
const WORK = 'docs/submission/video/assets/render';
const OUT = 'docs/submission/video/copc-cesium-demo.mp4';
const FPS = 30;
const GAP = 0.55; // 구간 사이 호흡(초)
const XF = 0.4; // 자막 페이드(초)

function ffmpegPath(): string {
  for (const c of ['ffmpeg', join(process.env.LOCALAPPDATA ?? '', 'Microsoft/WinGet/Links/ffmpeg.exe')]) {
    if (spawnSync(c, ['-version'], { stdio: 'ignore' }).status === 0) return c;
  }
  throw new Error('ffmpeg 를 찾지 못했다');
}

function run(bin: string, args: string[], label: string): void {
  const r = spawnSync(bin, args, { stdio: ['ignore', 'ignore', 'pipe'], encoding: 'utf8' });
  if (r.status !== 0) {
    console.error(String(r.stderr).split('\n').slice(-12).join('\n'));
    throw new Error(`${label} 실패`);
  }
}

/** 자막 + 태그 오버레이(투명 PNG). 브라우저로 그려야 한글 조판이 안정적이다. */
function overlayHtml(text: string, tag?: string): string {
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    *{margin:0;padding:0;box-sizing:border-box}
    html,body{width:${W}px;height:${H}px;background:transparent;
      font-family:"Malgun Gothic","맑은 고딕",system-ui,sans-serif;-webkit-font-smoothing:antialiased}
    .sub{position:absolute;left:0;right:0;bottom:78px;display:flex;justify-content:center}
    .sub span{background:rgba(6,11,20,.82);border:1px solid rgba(90,130,190,.35);
      color:#eef4fc;font-size:40px;font-weight:600;line-height:1.35;
      padding:20px 38px;border-radius:14px;max-width:1500px;text-align:center}
    .tag{position:absolute;top:64px;right:70px;background:rgba(6,11,20,.8);
      border:1px solid rgba(90,130,190,.35);color:#9dc0f0;font-size:28px;font-weight:700;
      padding:14px 26px;border-radius:999px}
  </style></head><body>
    ${tag ? `<div class="tag">${esc(tag)}</div>` : ''}
    ${text ? `<div class="sub"><span>${esc(text)}</span></div>` : ''}
  </body></html>`;
}

async function shot(page: Page, html: string, out: string, transparent: boolean): Promise<void> {
  await page.setContent(html, { waitUntil: 'load' });
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: out, omitBackground: transparent });
}

/** 검증 구간: 실제 출력 로그를 한 줄씩 드러내는 터미널 클립. */
async function renderTerminalClip(page: Page, ffmpeg: string, secs: number, out: string): Promise<void> {
  const raw = readFileSync('docs/submission/video/assets/verify-output.txt', 'utf8').split('\n');
  // 화면에 담기게 핵심 줄만 고른다 — 내용은 실제 출력 그대로다(가공 없음).
  // 구분선은 빼고 명령·PASS·집계만. 화면 여백(자막 자리)에 들어가는 줄 수로 맞춘다.
  const lines = raw
    .filter((l) => l.startsWith('$') || /PASS ✅/.test(l) || /^\d+\/\d+ passed/.test(l) || /ALL PASS/.test(l))
    .slice(-18);
  const dir = join(WORK, 'term');
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });

  const total = Math.round(secs * FPS);
  const holdFrames = Math.round(1.6 * FPS); // 마지막 상태 유지
  for (let i = 0; i < total; i++) {
    const t = Math.min(1, i / Math.max(1, total - holdFrames));
    const revealed = Math.max(1, Math.round(t * lines.length));
    await shot(page, terminalPage(lines, revealed), join(dir, `f${String(i).padStart(5, '0')}.jpg`), false);
  }
  run(
    ffmpeg,
    ['-v', 'error', '-framerate', String(FPS), '-i', join(dir, 'f%05d.jpg'),
      '-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-pix_fmt', 'yuv420p', '-y', out],
    'terminal clip',
  );
  rmSync(dir, { recursive: true, force: true });
}

async function main() {
  const ffmpeg = ffmpegPath();
  const ffprobe = ffprobePath();
  const metaFile = join(RAW, 'clips.json');
  const clipMeta: Record<string, { pathStart: number }> = existsSync(metaFile)
    ? JSON.parse(readFileSync(metaFile, 'utf8'))
    : {};
  rmSync(WORK, { recursive: true, force: true });
  mkdirSync(WORK, { recursive: true });

  const browser = await chromium.launch({ headless: true, args: ['--force-device-scale-factor=1'] });
  const page = await browser.newPage({ viewport: { width: W, height: H } });

  // 1) 카드 PNG
  for (const [id, html] of Object.entries(CARDS)) {
    await shot(page, html, join(WORK, `card-${id}.png`), false);
  }
  console.log(`카드 ${Object.keys(CARDS).length}장 렌더`);

  // 2) 검증 구간용 터미널 클립 — 실제 출력 로그를 한 줄씩 드러낸다.
  const verifySec = SECTIONS.find((s) => s.id === 's9-verify');
  if (verifySec) {
    const d = durationOf(ffprobe, audioPath(verifySec.id)) + GAP;
    await renderTerminalClip(page, ffmpeg, d, join(WORK, 'term.mp4'));
    console.log(`터미널 클립 ${d.toFixed(2)}s 렌더`);
  }

  // 3) 구간별 세그먼트
  const segs: string[] = [];
  for (const s of SECTIONS) {
    const mp3 = audioPath(s.id);
    if (!existsSync(mp3)) throw new Error(`${s.id}: 나레이션이 없다 — tsx scripts/video/tts.ts 를 먼저 돌려라`);
    const narr = durationOf(ffprobe, mp3);
    const dur = narr + GAP;

    // 2-1) 배경 영상 소스
    let vin: string[];
    if (s.id === 's9-verify') {
      // 검증 구간은 카드가 아니라 실제 출력 로그를 드러내는 터미널 클립을 쓴다.
      vin = ['-i', join(WORK, 'term.mp4')];
    } else if (s.visual.kind === 'card') {
      vin = ['-loop', '1', '-t', dur.toFixed(3), '-i', join(WORK, `card-${s.visual.card}.png`)];
    } else {
      const src = join(RAW, s.visual.src);
      if (!existsSync(src)) throw new Error(`${s.id}: 클립 없음 ${src}`);
      // 실시간 클립은 앞부분이 로딩 대기(빈 지구본)라 record.ts 가 남긴 경로 시작점을 인 포인트로 쓴다.
      // 사람이 눈으로 빈 화면을 찾지 않게 자동화한 것. clips.json 이 없으면 sections 의 from 을 쓴다.
      const meta = clipMeta[s.visual.src.replace(/\.(mp4|webm)$/, '')];
      const from = meta?.pathStart ?? s.visual.from ?? 0;
      vin = ['-stream_loop', '-1', '-ss', String(from), '-t', dur.toFixed(3), '-i', src];
    }

    // 2-2) 자막 오버레이 PNG — 구간을 자막 수로 등분
    const subPngs: string[] = [];
    for (let i = 0; i < s.subtitles.length; i++) {
      const p = join(WORK, `${s.id}-sub${i}.png`);
      await shot(page, overlayHtml(s.subtitles[i], i === 0 ? s.tags?.[0] : s.tags?.[0]), p, true);
      subPngs.push(p);
    }

    // 2-3) 필터그래프: 배경 스케일 → 자막을 시간대별로 겹침
    const inputs = [...vin];
    for (const p of subPngs) inputs.push('-i', p);
    const slot = dur / Math.max(1, subPngs.length);
    let chain = `[0:v]scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2,fps=${FPS},format=yuv420p[bg]`;
    let last = 'bg';
    subPngs.forEach((_, i) => {
      const a = i * slot;
      const b = i === subPngs.length - 1 ? dur : (i + 1) * slot;
      const lbl = `v${i}`;
      chain += `;[${last}][${i + 1}:v]overlay=0:0:enable='between(t,${a.toFixed(3)},${(b - 0.02).toFixed(3)})'[${lbl}]`;
      last = lbl;
    });

    const seg = join(WORK, `seg-${s.id}.mp4`);
    run(
      ffmpeg,
      ['-v', 'error', ...inputs, '-i', mp3,
        '-filter_complex', chain,
        '-map', `[${last}]`, '-map', `${subPngs.length + 1}:a`,
        '-t', dur.toFixed(3),
        '-af', `apad,atrim=0:${dur.toFixed(3)},aresample=48000`,
        '-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-pix_fmt', 'yuv420p',
        '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2',
        '-movflags', '+faststart', '-y', seg],
      `세그먼트 ${s.id}`,
    );
    segs.push(seg);
    console.log(`  ${s.id.padEnd(18)} ${dur.toFixed(2)}s  (나레이션 ${narr.toFixed(2)}s)`);
  }

  await browser.close();

  // 4) 이어붙이기
  const listFile = join(WORK, 'concat.txt');
  writeFileSync(listFile, segs.map((f) => `file '${f.replace(/\\/g, '/').replace(/^.*\//, '')}'`).join('\n'));
  run(
    ffmpeg,
    ['-v', 'error', '-f', 'concat', '-safe', '0', '-i', listFile, '-c', 'copy', '-movflags', '+faststart', '-y', OUT],
    '이어붙이기',
  );

  const total = durationOf(ffprobe, OUT);
  console.log(`\n완성 → ${OUT}   ${Math.floor(total / 60)}분 ${(total % 60).toFixed(0)}초`);
}

main().catch((e) => {
  console.error('[build] fatal', e);
  process.exit(1);
});
