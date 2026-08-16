// 이슈 #31 재현 — 데모 HUD 의 "로드된 노드" 가 실제 로드 수를 따라가는지 잰다.
// 가설: HUD 를 초기 1회만 그려서, 스트리밍이 계속 도는데도 숫자가 멈춰 있다.
// 판정: 안정화 후 HUD 가 말하는 노드 수 vs tileset.statistics 의 실제 수를 대조한다.
//
// 사용: dev 서버 먼저(`npm run dev`) → `tsx scripts/bench/repro-31.ts [ds=sofi]`
import { chromium } from 'playwright';

const ds = process.argv[2] || 'sofi';
const PORT = process.env.PORT || '5173';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** HUD 가 실제의 이 비율 이상은 말해야 한다(스냅샷이면 한참 못 미친다). */
const MIN_RATIO = 0.5;

async function main() {
  const browser = await chromium.launch({ headless: true, args: ['--ignore-gpu-blocklist', '--use-angle=d3d11'] });
  const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log('[pageerror]', e.message.slice(0, 200)));
  await page.goto(`http://localhost:${PORT}/?ds=${ds}`, { waitUntil: 'domcontentloaded', timeout: 60000 });

  // 안정화까지 대기 — 이 시점이면 노드가 충분히 쌓여 있다.
  let prev = -1;
  let stable = 0;
  let real = 0;
  for (let i = 0; i < 240; i++) {
    await sleep(500);
    real = await page.evaluate(() => {
      const p = (window as any).viewer?.scene?.primitives;
      for (let i = 0; i < (p?.length ?? 0); i++) {
        const t = p.get(i);
        if (t?.statistics?.numberOfTilesWithContentReady != null) return t.statistics.numberOfTilesWithContentReady;
      }
      return 0;
    });
    if (real === prev && real > 0) { stable += 500; if (stable >= 3000) break; } else { stable = 0; prev = real; }
  }
  if (real <= 0) throw new Error('타일이 준비되지 않았다 — 재현 불가');

  // HUD 가 말하는 수 (화면에 실제로 보이는 문자열에서 읽는다)
  const hud = await page.evaluate(() => {
    const divs = Array.from(document.querySelectorAll('body > div'));
    const el = divs.find((d) => (d.textContent ?? '').includes('로드된 노드'));
    return el?.textContent ?? '';
  });
  const m = hud.match(/로드된 노드:\s*(\d+)\s*\(실패\s*(\d+)\)/);
  if (!m) throw new Error(`HUD 에서 노드 수를 못 읽었다:\n${hud.slice(0, 200)}`);
  const shown = Number(m[1]);
  const failed = Number(m[2]);

  const ratio = shown / real;
  const pass = failed === 0 && ratio >= MIN_RATIO;

  console.log(`[repro-31] ds=${ds}`);
  console.log(`  HUD 표시     로드된 노드 ${shown} (실패 ${failed})`);
  console.log(`  실제(statistics) ${real}`);
  console.log(`  따라가는 비율 ${(ratio * 100).toFixed(0)}%   (최소 ${MIN_RATIO * 100}%)`);
  console.log(`  판정: ${pass ? 'PASS — HUD 가 실제 로드를 반영' : 'FAIL — HUD 가 낡은 값에 고정'}`);

  await browser.close();
  process.exit(pass ? 0 : 1);
}

main().catch((e) => {
  console.error('[repro-31] fatal', e);
  process.exit(2);
});
