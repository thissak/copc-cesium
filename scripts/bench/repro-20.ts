// 이슈 #20 실해 측정 — 취소 미전파(Phase 0 게이트 FAIL)의 *실제 영향*을 잰다.
// 가설: Cesium 은 취소 시 동시성 슬롯을 즉시 해제하나 SW→page→worker 는 계속 도므로,
//       지속 churn 시 page 의 in-flight 디코드(=좀비 포함)가 무계 누적될 수 있다.
// 판정: 지속 churn 동안 in-flight 궤적이 (a) 유계(throttle≈6 부근 진동) → 양성/won't-fix
//                                        (b) 단조 증가 → 무계 누적/실해 → 완화책 필요.
// 부가: churn 종료 후 드레인(worker 가 카메라 정지 뒤에도 좀비를 얼마나 더 디코드하는지).
//
// 사용: dev 서버 먼저(`npm run dev`) → `tsx scripts/bench/repro-20.ts [msse=4] [churnSecs=15]`
import { chromium } from 'playwright';
import { resolve } from 'path';
import { fileURLToPath } from 'url';

const PROBE_BUNDLE = resolve(fileURLToPath(import.meta.url), '../probe-bundle.js');
const msse = Number(process.argv[2] || '4');
const churnSecs = Number(process.argv[3] || '15');
const PORT = process.env.PORT || '5173';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Stats = { started: number; done: number; inflight: number };
type CesiumStat = { pending: number; processing: number; tilesReady: number; pointsSelected: number };

async function decodeStats(page: any, idx: number): Promise<Stats> {
  return page.evaluate((i: number) => (window as any).viewer.scene.primitives.get(i).copcDecodeStats(), idx);
}
async function cesiumStats(page: any, idx: number): Promise<CesiumStat> {
  return page.evaluate((i: number) => (window as any).BenchProbe.readStats(i), idx);
}

// 공격적 churn 을 page 안에서 fire-and-forget 으로 돌린다(60ms 마다 카메라 급변 → Cesium 이 타일 요청·취소 폭주).
// Node 는 그 동안 copcDecodeStats 를 고빈도로 샘플(동시) → in-flight 궤적 포착.
async function startChurn(page: any, idx: number, secs: number) {
  // 문자열로 전달 — tsx/esbuild 의 __name 주입 footgun 회피(중첩 async 함수 때문).
  await page.evaluate(`(() => {
    const v = window.viewer;
    const ts = v.scene.primitives.get(${idx});
    const bs = ts.boundingSphere;
    const cam = v.camera;
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    // deep zoom 1회 (리셋 없음) → 이후 연속 회전(orbit)으로 새 섹터를 계속 시야에 넣어 새 노드 요청·이전 노드 취소 유발.
    cam.flyToBoundingSphere(bs, { duration: 0 });
    cam.zoomIn(bs.radius * 0.9);
    window.__churnDone = false;
    (async () => {
      const end = performance.now() + ${secs} * 1000;
      let ph = 0;
      while (performance.now() < end) {
        cam.rotateRight(0.25);          // 연속 회전 — 새 섹터
        if (ph % 7 === 6) cam.zoomIn(bs.radius * 0.05);  // 가끔 더 깊이(고해상 노드)
        ph++;
        v.scene.requestRender();
        await sleep(40);                // 공격적
      }
      window.__churnDone = true;
    })();
  })()`);
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.addInitScript({ path: PROBE_BUNDLE });
  await page.goto(`http://localhost:${PORT}/?ds=sofi`, { waitUntil: 'domcontentloaded' });

  let idx = -1; const t0 = Date.now();
  while (Date.now() - t0 < 45000) { idx = await page.evaluate(() => (window as any).BenchProbe.findTilesetIndex()); if (idx >= 0) break; await sleep(500); }
  if (idx < 0) throw new Error('tileset not found in 45s');
  await page.evaluate((a: { idx: number; msse: number }) => (window as any).BenchProbe.normalizeAndAnchor(a), { idx, msse });

  // 1) settle baseline
  let prev = -1, stable = 0; const s0 = Date.now();
  while (Date.now() - s0 < 60000) {
    const cs = await cesiumStats(page, idx);
    if (cs.pending === 0 && cs.tilesReady === prev && cs.tilesReady > 0) { stable += 300; if (stable >= 2400) break; }
    else { stable = 0; prev = cs.tilesReady; }
    await sleep(300);
  }
  const base = await decodeStats(page, idx);
  const baseCes = await cesiumStats(page, idx);
  console.log(`\n=== REPRO #20 (sofi msse=${msse}, churn ${churnSecs}s, headless) ===`);
  console.log(`settle: decodes started=${base.started} done=${base.done} inflight=${base.inflight} | tilesReady=${baseCes.tilesReady} pending=${baseCes.pending}`);

  // 2) 공격적 churn(page 내 fire-and-forget) + 고빈도 in-flight 샘플링(Node, 동시)
  console.log(`\n--- 공격적 churn 동안 in-flight 궤적 (유계 vs 무계) ---`);
  const inflightSamples: number[] = [];
  await startChurn(page, idx, churnSecs);
  const cStart = Date.now(); let tick = 0;
  while (Date.now() - cStart < (churnSecs + 0.5) * 1000) {
    const ds = await decodeStats(page, idx);
    inflightSamples.push(ds.inflight);
    if (tick++ % 5 === 0) {
      const cs = await cesiumStats(page, idx);
      console.log(`  t=${((Date.now() - cStart) / 1000).toFixed(1)}s  inflight=${ds.inflight.toString().padStart(3)}  started=${ds.started} done=${ds.done}  | cesium pending=${cs.pending} processing=${cs.processing}`);
    }
    await sleep(150); // 고빈도 샘플(공격적 churn 60ms 보다 성기지만 in-flight 누적이면 포착됨)
  }
  const churnEnd = await decodeStats(page, idx);

  // 3) 카메라 정지(고정 앵커) → 드레인: worker 가 좀비를 얼마나 더 디코드하나
  await page.evaluate((i: number) => {
    const v: any = (window as any).viewer; const ts: any = v.scene.primitives.get(i);
    v.camera.flyToBoundingSphere(ts.boundingSphere, { duration: 0 }); v.scene.requestRender();
  }, idx);
  const drainStart = Date.now(); let dPrev = -1, dStable = 0; let drainMs = 0;
  while (Date.now() - drainStart < 30000) {
    const ds = await decodeStats(page, idx);
    if (ds.inflight === 0 && ds.done === dPrev) { dStable += 300; if (dStable >= 1500) { drainMs = Date.now() - drainStart - 1500; break; } }
    else { dStable = 0; dPrev = ds.done; }
    await sleep(300);
  }
  const fin = await decodeStats(page, idx);

  // --- 판정 ---
  const peak = Math.max(...inflightSamples, 0);
  const last3 = inflightSamples.slice(-3);
  const first3 = inflightSamples.slice(0, 3);
  const avgFirst = first3.reduce((a, b) => a + b, 0) / Math.max(1, first3.length);
  const avgLast = last3.reduce((a, b) => a + b, 0) / Math.max(1, last3.length);
  const churnDecodes = churnEnd.started - base.started;
  const drainDecodes = fin.done - churnEnd.done; // churn 종료 후 추가 완료(=좀비 백로그 드레인 포함)

  console.log(`\n--- 결과 ---`);
  console.log(`in-flight peak=${peak}  초반평균=${avgFirst.toFixed(1)}  후반평균=${avgLast.toFixed(1)}  (단조증가면 무계 누적)`);
  console.log(`churn 중 디코드 요청=${churnDecodes}  | churn 종료 후 드레인 디코드=${drainDecodes}  드레인시간=${(drainMs / 1000).toFixed(1)}s`);
  console.log(`최종 inflight=${fin.inflight} (0 으로 수렴해야 정상)`);
  console.log(
    avgLast > avgFirst * 1.8 && peak > 12
      ? `\n판정: in-flight 단조 증가·throttle(6) 초과 → 무계 누적 가능 (실해) → 완화책 검토`
      : `\n판정: in-flight 유계(throttle 부근) → 좀비 누적 제한적 (won't-fix 후보, 데이터 첨부)`,
  );

  await browser.close();
}
main().catch((e) => { console.error('fatal', e); process.exit(1); });
