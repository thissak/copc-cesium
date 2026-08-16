// 출품 시연영상 원본 클립 녹화 — 실제 앱을 Playwright 로 구동해 결정적 카메라 경로로 찍는다.
//
// 원칙: 합성 화면이 아니라 **실제 동작 화면**만 쓴다. 같은 인자로 다시 돌리면 같은 그림이 나온다.
//
// 두 가지 모드 (하이브리드):
//   offline  — 프레임 단위로 카메라를 전진시키며 JPEG q95 로 캡처 → ffmpeg 로 30fps 고비트레이트 인코딩.
//              화질·부드러움 최상. 단 벽시계와 분리되므로 **로딩이 끝난(settled) 정지 장면에만** 쓴다.
//              화면의 FPS 카운터는 캡처 속도를 찍게 되므로 반드시 끈다(성능 왜곡 금지).
//   realtime — Playwright recordVideo 로 벽시계 그대로 녹화(VP8 25fps).
//              스트리밍이 채워지는 과정처럼 **속도 자체가 주장인 장면**에 쓴다. FPS 카운터를 남긴다.
//
// 사용:
//   npm run dev                                      # 먼저 dev 서버
//   tsx scripts/video/record.ts                      # 전체 샷
//   tsx scripts/video/record.ts autzen-orbit-rgb     # 특정 샷만
//
// 출력: docs/submission/video/assets/raw/<shot>.{mp4,webm}  (gitignore — 대용량 중간 산출물)
import { chromium, type Page } from 'playwright';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const OUT_DIR = 'docs/submission/video/assets/raw';
const FRAME_DIR = 'docs/submission/video/assets/render';
const PORT = process.env.PORT || '5173';
const VIEWPORT = { width: 1920, height: 1080 };
const FPS = 30;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// 헤드리스로 돈다. 실측: 헤드리스에서도 실 GPU(ANGLE/D3D11, RTX 4090)가 그대로 붙고 캡처가 오히려 빠르다
// (117ms → 72ms/프레임). 헤드풀은 screenshot 마다 뷰포트를 리사이즈해 화면이 깜빡이므로 쓰지 않는다.
const LAUNCH_ARGS = ['--ignore-gpu-blocklist', '--enable-gpu-rasterization', '--use-angle=d3d11', '--hide-scrollbars'];

// winget 설치본은 PATH 갱신 전이라 새 셸에서 안 잡힐 수 있다 → 후보를 직접 훑는다.
function ffmpegPath(): string {
  const candidates = [
    'ffmpeg',
    join(process.env.LOCALAPPDATA ?? '', 'Microsoft/WinGet/Links/ffmpeg.exe'),
  ];
  for (const c of candidates) {
    const r = spawnSync(c, ['-version'], { stdio: 'ignore' });
    if (r.status === 0) return c;
  }
  throw new Error('ffmpeg 를 찾지 못했다 — winget install Gyan.FFmpeg');
}

interface Shot {
  name: string;
  ds: 'autzen' | 'millsite' | 'sofi';
  secs: number;
  mode: 'offline' | 'realtime';
  /** 분류 스타일(키 c) 을 켠 상태로 찍을지. */
  classified?: boolean;
  /** 카메라 경로. */
  path: 'orbit' | 'dive' | 'hold';
  /** 점 조회 시연: 경로 도중 캔버스를 클릭해 pick 패널을 띄운다(초 단위 시점 목록). */
  picks?: number[];
}

// 3분 구성의 원본 소재. 편집에서 골라 쓰므로 각 샷은 독립적으로 완결되게 찍는다.
const SHOTS: Shot[] = [
  // 대표 예제 — Autzen RGB. 원본 색으로 "변환 없이 바로 뜬다".
  { name: 'autzen-orbit-rgb', ds: 'autzen', secs: 20, mode: 'offline', path: 'orbit' },
  // 같은 데이터, 분류 스타일 — 표준 Cesium3DTileStyle 이 그대로 먹는다는 증거.
  { name: 'autzen-orbit-class', ds: 'autzen', secs: 16, mode: 'offline', classified: true, path: 'orbit' },
  // 줌인하며 LOD 가 채워지는 과정 — 속도가 곧 주장이므로 실시간.
  { name: 'autzen-dive-lod', ds: 'autzen', secs: 18, mode: 'realtime', path: 'dive' },
  // 대형 데이터 증명 — SoFi 1.9GB. 사전 변환 없이 원본에서 바로.
  { name: 'sofi-orbit', ds: 'sofi', secs: 20, mode: 'offline', path: 'orbit' },
  { name: 'sofi-dive-lod', ds: 'sofi', secs: 20, mode: 'realtime', path: 'dive' },
  // 점 조회 — 클릭하면 그 점의 좌표·LAS 속성과 옥트리 풀해상도 최근접점(snap)이 뜬다.
  // 사전 변환된 pnts 만 가진 엔진은 원본 점에 접근할 수 없어 구조적으로 못 하는 일이다.
  // 클릭을 이르게·촘촘히 둔다. 첫 클릭이 늦거나 빗나가면 구간 앞부분이 "패널 없는 빈 화면"이 된다
  // (1차 촬영에서 앞 6초가 비어 나레이션만 흐르는 결함 발생 — 이웃 세션 교차검토에서 발견).
  { name: 'autzen-pick', ds: 'autzen', secs: 16, mode: 'realtime', path: 'hold', picks: [1, 4.5, 8.5, 12.5] },
];

// 내비 도움말 팝업과 툴바는 시연에 불필요 — 항상 가린다.
// HUD(노드 수·로드 시간)와 Cesium 크레딧은 남긴다(증거·표기 의무).
const HIDE_UI = `.cesium-viewer-toolbar, .cesium-navigation-help { display: none !important; }`;
// pick 패널은 데모 기본이 12px 라 1080p 영상에서 안 읽힌다. 녹화 화면에서만 키운다(제품 변경 아님).
const BIG_PICK_PANEL = `
  #pick-panel {
    font-size: 24px !important; line-height: 1.55 !important;
    padding: 18px 22px !important; max-width: 620px !important;
    border-radius: 10px !important; background: rgba(6,11,20,.88) !important;
    border: 1px solid rgba(90,130,190,.45) !important;
    top: 20px !important; right: 20px !important;
  }`;

/** u(0..1) → 카메라 포즈. offline·realtime 이 같은 식을 써야 그림이 일치한다. */
const POSE_FN = `(kind, u) => {
  if (kind === 'orbit') return {
    heading: 0.4 + u * Math.PI * 2,                    // 한 바퀴
    pitch: -0.42 - 0.1 * Math.sin(u * Math.PI * 2),
    rangeK: 2.0 - 0.35 * Math.sin(u * Math.PI),        // 살짝 다가갔다 물러난다
  };
  if (kind === 'dive') return {
    heading: 0.4 + u * Math.PI * 0.7,                  // 완만한 선회
    pitch: -0.5 + 0.12 * u,
    rangeK: 2.4 - 2.05 * u,                            // 멀리서 → 깊게 (LOD 채워지는 걸 보여준다)
  };
  return { heading: 0.4, pitch: -0.45, rangeK: 2.0 };
}`;

// 실시간 클립은 로딩 대기 구간까지 녹화되므로, 카메라 경로가 시작된 지점을 기록해 둔다.
// build.ts 가 이 값을 인 포인트로 써서 빈 화면을 자동으로 건너뛴다(사람이 눈으로 찾지 않는다).
const META = join(OUT_DIR, 'clips.json');
function recordClipMeta(name: string, pathStart: number): void {
  const cur = existsSync(META) ? JSON.parse(readFileSync(META, 'utf8')) : {};
  cur[name] = { pathStart: +pathStart.toFixed(2) };
  writeFileSync(META, JSON.stringify(cur, null, 2));
}

/** tileset 객체가 scene 에 들어올 때까지만 기다린다(로딩 완료가 아니라 *생성*까지). */
async function waitForTileset(page: Page, maxMs = 120000): Promise<void> {
  const t0 = Date.now();
  while (Date.now() - t0 < maxMs) {
    const found = await page.evaluate(() => {
      const p = (window as any).viewer?.scene?.primitives;
      for (let i = 0; i < (p?.length ?? 0); i++) if (p.get(i)?.copcPointBoundingSphere) return true;
      return false;
    });
    if (found) return;
    await sleep(300);
  }
  throw new Error('tileset 이 생성되지 않았다 (copcPointBoundingSphere 없음)');
}

async function settle(page: Page, quietMs = 2500, maxMs = 120000): Promise<number> {
  let prev = -1;
  let stable = 0;
  const t0 = Date.now();
  let ready = 0;
  while (Date.now() - t0 < maxMs) {
    await sleep(500);
    ready = await page.evaluate(() => {
      const p = (window as any).viewer?.scene?.primitives;
      for (let i = 0; i < (p?.length ?? 0); i++) {
        const t = p.get(i);
        if (t?.statistics?.numberOfTilesWithContentReady != null) return t.statistics.numberOfTilesWithContentReady;
      }
      return 0;
    });
    if (ready === prev && ready > 0) {
      stable += 500;
      if (stable >= quietMs) return ready;
    } else {
      stable = 0;
      prev = ready;
    }
  }
  return ready;
}

/**
 * 페이지에 카메라 헬퍼를 심는다. 본문을 문자열로 넘기는 건 tsx/esbuild 가 중첩 함수에 `__name`
 * 주입을 하는데 페이지엔 그 헬퍼가 없어 ReferenceError 가 나기 때문(=`scripts/bench/repro-20.ts` 와 같은 회피).
 */
async function installCameraHelper(page: Page): Promise<void> {
  await page.evaluate(`(() => {
    const v = window.viewer, scene = v.scene;
    let ts = null;
    for (let i = 0; i < scene.primitives.length; i++) {
      const t = scene.primitives.get(i);
      if (t && t.copcPointBoundingSphere) { ts = t; break; }
    }
    if (!ts) throw new Error('copcPointBoundingSphere 를 가진 tileset 을 못 찾았다');
    // 조준은 옥트리 큐브가 아니라 실제 점 범위 구로 (이슈 #28).
    const bs = ts.copcPointBoundingSphere;
    const pose = ${POSE_FN};
    window.__setPose = (kind, u) => {
      const p = pose(kind, u);
      v.camera.lookAt(bs.center, { heading: p.heading, pitch: p.pitch, range: bs.radius * p.rangeK });
      scene.requestRender();
    };
    window.__releaseCamera = () => v.camera.lookAtTransform([1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1]);
    // 실시간 경로: rAF 마다 새 포즈 → 렌더 프레임 단위로 부드럽다.
    window.__runPath = (kind, secs) => new Promise((resolve) => {
      const t0 = performance.now(), dur = secs * 1000;
      const step = () => {
        const u = Math.min(1, (performance.now() - t0) / dur);
        window.__setPose(kind, u);
        if (u < 1) requestAnimationFrame(step); else { window.__releaseCamera(); resolve(); }
      };
      requestAnimationFrame(step);
    });
  })()`);
}

async function openPage(shot: Shot, ctx: any): Promise<Page> {
  const page = await ctx.newPage();
  page.on('pageerror', (e: Error) => console.log(`  [pageerror] ${e.message.slice(0, 160)}`));
  await page.goto(`http://localhost:${PORT}/?ds=${shot.ds}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.addStyleTag({ content: HIDE_UI + (shot.picks?.length ? BIG_PICK_PANEL : '') });
  return page;
}

/** 프레임 단위 오프라인 렌더 — 화질 최상. 로딩이 끝난 장면에만. */
async function recordOffline(shot: Shot, ff: string): Promise<string> {
  const frames = join(FRAME_DIR, shot.name);
  rmSync(frames, { recursive: true, force: true });
  mkdirSync(frames, { recursive: true });

  const browser = await chromium.launch({ headless: true, args: LAUNCH_ARGS });
  const ctx = await browser.newContext({ viewport: VIEWPORT });
  const page = await openPage(shot, ctx);

  const ready = await settle(page);
  console.log(`  settled: ${ready} tiles`);
  // FPS 카운터는 캡처 속도를 찍으므로 끈다 — 성능을 실제보다 낮게 보이게 하면 안 된다.
  await page.evaluate(() => { (window as any).viewer.scene.debugShowFramesPerSecond = false; });
  if (shot.classified) {
    await page.evaluate(() => (window as any).__copcStyle?.(true));
    await sleep(1200);
  }
  await installCameraHelper(page);

  const total = shot.secs * FPS;
  const t0 = Date.now();
  for (let i = 0; i < total; i++) {
    await page.evaluate(
      `window.__setPose(${JSON.stringify(shot.path)}, ${total > 1 ? i / (total - 1) : 0})`,
    );
    const buf = await page.screenshot({ type: 'jpeg', quality: 95 });
    writeFileSync(join(frames, `f${String(i).padStart(5, '0')}.jpg`), buf);
    if ((i + 1) % 60 === 0) {
      const rate = (i + 1) / ((Date.now() - t0) / 1000);
      console.log(`  ${i + 1}/${total} frames  (${rate.toFixed(1)} fps 캡처, 남은 ~${((total - i - 1) / rate).toFixed(0)}s)`);
    }
  }
  await page.evaluate('window.__releaseCamera()');
  await browser.close();

  const dst = join(OUT_DIR, `${shot.name}.mp4`);
  const enc = spawnSync(
    ff,
    ['-v', 'error', '-framerate', String(FPS), '-i', join(frames, 'f%05d.jpg'),
      '-c:v', 'libx264', '-preset', 'slow', '-crf', '16', '-pix_fmt', 'yuv420p', '-y', dst],
    { stdio: 'inherit' },
  );
  if (enc.status !== 0) throw new Error(`${shot.name}: ffmpeg 인코딩 실패`);
  rmSync(frames, { recursive: true, force: true }); // 중간 프레임 정리(수백 MB)
  return dst;
}

/** 실시간 녹화 — 벽시계 그대로. 스트리밍처럼 속도가 주장인 장면에. */
async function recordRealtime(shot: Shot): Promise<string> {
  const browser = await chromium.launch({ headless: true, args: LAUNCH_ARGS });
  const ctx = await browser.newContext({
    viewport: VIEWPORT,
    recordVideo: { dir: OUT_DIR, size: VIEWPORT },
  });
  const t0 = Date.now(); // 녹화는 컨텍스트 생성 시점부터 — 경로 시작 오프셋을 재둔다
  const page = await openPage(shot, ctx);

  // 초기 로딩이 끝난 뒤부터 움직인다. 안 그러면 앞부분이 빈 지구본(globe.baseColor 올리브색)만 나온다.
  // 파고드는 동안 채워지는 깊은 LOD 는 여전히 진짜 실시간이므로 "실시간" 주장은 그대로다.
  const ready = await settle(page);
  console.log(`  settled: ${ready} tiles`);
  if (shot.classified) {
    await page.evaluate(() => (window as any).__copcStyle?.(true));
    await sleep(1200);
  }
  await installCameraHelper(page);
  await sleep(500); // 정지 상태 한 박자 — 편집에서 인 포인트로 쓴다
  const pathStart = (Date.now() - t0) / 1000;
  const path = page.evaluate(`window.__runPath(${JSON.stringify(shot.path)}, ${shot.secs})`);
  // 점 조회 시연: 경로가 도는 동안 캔버스를 실제로 클릭한다(데모의 LEFT_CLICK 핸들러가 받는다).
  // 화면 여러 곳을 찍어 좌표·속성이 점마다 다르게 나오는 걸 보여준다.
  if (shot.picks?.length) {
    // 점군이 확실히 덮는 중앙부 위주로 고른다 — 빗나가면 패널이 안 뜬다.
    const spots: Array<[number, number]> = [
      [960, 560], // 중앙 구조물(경기장)
      [870, 640], // 중앙 좌하 지면
      [1080, 600], // 중앙 우 식생
      [960, 700], // 중앙 하단
    ];
    const clickAt = Date.now();
    for (let i = 0; i < shot.picks.length; i++) {
      const wait = shot.picks[i] * 1000 - (Date.now() - clickAt);
      if (wait > 0) await sleep(wait);
      const [x, y] = spots[i % spots.length];
      await page.mouse.click(x, y);
    }
  }
  await path;
  await sleep(600); // 끝 여백 (편집 시 컷 여유)
  recordClipMeta(shot.name, pathStart);

  await ctx.close(); // 여기서 webm 이 flush 된다
  await browser.close();

  // Playwright 는 임의 해시 파일명을 쓰므로 방금 만들어진 것을 골라 샷 이름으로 바꾼다.
  const known = new Set(SHOTS.map((s) => `${s.name}.webm`));
  const src = readdirSync(OUT_DIR)
    .filter((f) => f.endsWith('.webm') && !known.has(f))
    .map((f) => ({ f, mtime: statSync(join(OUT_DIR, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime)[0]?.f;
  if (!src) throw new Error(`${shot.name}: Playwright 가 webm 을 남기지 않았다`);
  const dst = join(OUT_DIR, `${shot.name}.webm`);
  renameSync(join(OUT_DIR, src), dst);
  return dst;
}

async function main() {
  const only = process.argv.slice(2);
  const list = only.length ? SHOTS.filter((s) => only.includes(s.name)) : SHOTS;
  if (!list.length) {
    console.error(`no matching shot. available: ${SHOTS.map((s) => s.name).join(', ')}`);
    process.exit(2);
  }
  const ff = ffmpegPath();
  mkdirSync(OUT_DIR, { recursive: true });
  const done: string[] = [];
  for (const shot of list) {
    console.log(`▶ ${shot.name}  (${shot.ds}, ${shot.secs}s, ${shot.path}, ${shot.mode})`);
    const out = shot.mode === 'offline' ? await recordOffline(shot, ff) : await recordRealtime(shot);
    const mb = (statSync(out).size / 1048576).toFixed(1);
    console.log(`  → ${out}  (${mb} MB)\n`);
    done.push(out);
  }
  console.log(`done — ${done.length} clips`);
  for (const d of done) console.log(`  ${d}`);
  if (existsSync(FRAME_DIR)) rmSync(FRAME_DIR, { recursive: true, force: true });
}

main().catch((e) => {
  console.error('[record] fatal', e);
  process.exit(1);
});
