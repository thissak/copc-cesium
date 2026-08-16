// 영상용 정지 카드 HTML — Playwright 로 1920×1080 PNG 렌더한다.
// 점군 화면과 톤을 맞춘 어두운 배경. 한글 본문은 Malgun Gothic, 코드는 고정폭.

export const W = 1920;
export const H = 1080;

const BASE = `
  * { margin:0; padding:0; box-sizing:border-box; }
  html, body { width:${W}px; height:${H}px; }
  body {
    background: radial-gradient(1200px 800px at 30% 20%, #16233a 0%, #0b1220 55%, #070c15 100%);
    color:#e8eef7;
    font-family:"Malgun Gothic","맑은 고딕",system-ui,sans-serif;
    display:flex; align-items:center; justify-content:center;
    -webkit-font-smoothing:antialiased;
  }
  .wrap { width:1520px; }
  .kicker { font-size:26px; letter-spacing:.18em; color:#5d9dfb; font-weight:700; margin-bottom:26px; }
  h1 { font-size:104px; font-weight:800; letter-spacing:-.02em; line-height:1.06; }
  h2 { font-size:64px; font-weight:700; letter-spacing:-.01em; line-height:1.2; }
  .sub { margin-top:28px; font-size:34px; color:#9db2cd; line-height:1.5; font-weight:400; }
  code, pre { font-family:"Cascadia Mono","Consolas",ui-monospace,monospace; }
  pre {
    margin-top:44px; background:#0a1a2f; border:1px solid #1e3350; border-radius:14px;
    padding:38px 42px; font-size:30px; line-height:1.62; color:#d7e6fb; overflow:hidden;
  }
  .k { color:#7aa2f7; } .s { color:#9ece6a; } .c { color:#5b7089; } .f { color:#e0af68; }
  .row { display:flex; gap:20px; margin-top:36px; flex-wrap:wrap; }
  .chip {
    background:#12233d; border:1px solid #24405f; border-radius:999px;
    padding:14px 28px; font-size:27px; color:#bcd2ee;
  }
  table { width:100%; border-collapse:collapse; margin-top:40px; font-size:33px; }
  td { padding:20px 8px; border-bottom:1px solid #1b2d47; }
  td.v { text-align:right; font-family:"Cascadia Mono","Consolas",monospace; color:#9ece6a; font-weight:700; }
  .flow { margin-top:52px; font-size:35px; line-height:2.0; color:#cfe0f5; }
  .flow b { color:#7aa2f7; font-weight:700; }
  .flow .arrow { color:#5b7089; margin:0 14px; }
`;

function page(body: string, extra = ''): string {
  return `<!doctype html><html><head><meta charset="utf-8"><style>${BASE}${extra}</style></head><body>${body}</body></html>`;
}

export const CARDS: Record<string, string> = {
  title: page(`
    <div class="wrap">
      <div class="kicker">2026 오픈소스 개발자대회</div>
      <h1>변환 없이,<br/>COPC를 그대로 Cesium에</h1>
      <div class="sub">@goldenlabs/copc-cesium · Apache-2.0</div>
    </div>
  `),

  'code-api': page(`
    <div class="wrap">
      <h2>한 줄이면 됩니다</h2>
      <pre><span class="k">import</span> { CopcTileset } <span class="k">from</span> <span class="s">'@goldenlabs/copc-cesium'</span>;

<span class="k">const</span> tileset = <span class="k">await</span> CopcTileset.<span class="f">fromUrl</span>(<span class="s">'https://…/cloud.copc.laz'</span>);
viewer.scene.primitives.<span class="f">add</span>(tileset);

<span class="c">// 반환값은 표준 Cesium3DTileset — 세슘의 스타일과 피킹이 그대로 동작</span></pre>
      <div class="row">
        <div class="chip">사전 변환 0단계</div>
        <div class="chip">peer: cesium ≥ 1.142</div>
        <div class="chip">Apache-2.0</div>
      </div>
    </div>
  `),

  arch: page(`
    <div class="wrap">
      <h2>동작 원리</h2>
      <div class="flow">
        <b>COPC 옥트리</b><span class="arrow">──▶</span>동적 <b>3D Tiles</b> 트리<br/>
        <span class="arrow">└</span> 어떤 노드를 언제 가져올지는 <b>Cesium</b>이 판단 (SSE)<br/>
        <span class="arrow">└</span> 타일 요청을 <b>Service Worker</b>가 가로챔<br/>
        <span class="arrow">└</span> 그 노드만 <b>Web Worker</b>에서 디코드 → pnts 응답
      </div>
      <div class="row">
        <div class="chip">LOD = Cesium 위임</div>
        <div class="chip">디코드 = Web Worker</div>
        <div class="chip">노드 공급 = Service Worker</div>
      </div>
    </div>
  `),

  // 측정 수치 — 전부 우리 코드의 before/after 자체 측정이라 타 엔진 인용 문제가 없다.
  metrics: page(`
    <div class="wrap">
      <h2>측정으로 만들었습니다</h2>
      <table>
        <tr><td>S3 range 왕복 <span style="color:#7e94b0">(요청 병합)</span></td><td class="v">61 → 6</td></tr>
        <tr><td>좌표 재투영 <span style="color:#7e94b0">(100만 점당)</span></td><td class="v">582 → 10.7 ms &nbsp;<b style="color:#e0af68">54×</b></td></tr>
        <tr><td>깊은 줌 <span style="color:#7e94b0">(점 예산 적용)</span></td><td class="v">16 → 89 fps</td></tr>
        <tr><td>대규모 스트레스 <span style="color:#7e94b0">(Cahokia 8.9GB, 90초)</span></td><td class="v">메모리 plateau</td></tr>
      </table>
      <div class="row">
        <div class="chip">모두 자체 before / after 실측</div>
        <div class="chip">4축 프로파일러</div>
      </div>
    </div>
  `),

  outro: page(`
    <div class="wrap" style="text-align:center">
      <h1 style="font-size:92px">copc-cesium</h1>
      <div class="sub" style="font-size:36px; margin-top:30px">
        변환 없이 COPC를 그대로 CesiumJS에 스트리밍
      </div>
      <div style="margin-top:52px; font-family:'Cascadia Mono','Consolas',monospace; font-size:34px; line-height:1.85; color:#9dc0f0">
        <div style="color:#6ee787">copc-cesium.vercel.app</div>
        <div>github.com/thissak/copc-cesium</div>
        <div style="color:#9db2cd">npm i @goldenlabs/copc-cesium</div>
      </div>
      <div class="row" style="justify-content:center; margin-top:44px">
        <div class="chip">Apache-2.0</div>
      </div>
    </div>
  `),
};

/** 검증 구간 — 실제 `npm test` / `test:integration` 출력을 터미널처럼 한 줄씩 드러낸다. */
export function terminalPage(lines: string[], revealed: number): string {
  const shown = lines.slice(0, revealed);
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const html = shown
    .map((l) => {
      const cls = /PASS ✅|ALL PASS|passed/.test(l)
        ? 'ok'
        : l.startsWith('$')
          ? 'cmd'
          : /^─+|─+$/.test(l.trim())
            ? 'sep'
            : '';
      return `<div class="l ${cls}">${esc(l) || '&nbsp;'}</div>`;
    })
    .join('');
  return page(
    `<div class="term"><div class="bar"><i></i><i></i><i></i><span>copc-cesium — 검증</span></div><div class="body">${html}</div></div>`,
    `
    body { display:block; padding:56px 70px; }
    .term { width:100%; height:${H - 112}px; background:#060b14; border:1px solid #1e3350; border-radius:16px;
            display:flex; flex-direction:column; overflow:hidden; }
    .bar { height:62px; flex:0 0 62px; background:#0d1a2b; border-bottom:1px solid #1e3350;
           display:flex; align-items:center; gap:12px; padding:0 24px; }
    .bar i { width:15px; height:15px; border-radius:50%; background:#2b4260; }
    .bar i:nth-child(1){background:#ff5f57} .bar i:nth-child(2){background:#febc2e} .bar i:nth-child(3){background:#28c840}
    .bar span { margin-left:16px; color:#7e94b0; font-size:24px; }
    /* 위에서 아래로 채워야 로그가 쌓이는 것처럼 읽힌다. 아래쪽은 자막이 덮으므로 비워 둔다. */
    .body { flex:1; padding:30px 34px 190px; font-family:"Cascadia Mono","Consolas",monospace;
            font-size:25px; line-height:1.42; color:#c6d7ee; display:flex; flex-direction:column; justify-content:flex-start; }
    .l { white-space:pre; }
    .l.ok { color:#6ee787; font-weight:700; }
    .l.cmd { color:#7aa2f7; font-weight:700; }
    .l.sep { color:#3d5473; }
  `,
  );
}
