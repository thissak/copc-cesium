import { defineConfig } from 'tsup';
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs';

// 소스는 dev(Vite) 친화 형태 유지; 라이브러리 출하용 변환은 빌드에서만 → demo(`npm run dev`) 무영향.
//
// 두 갈래 빌드:
//  1) index  — 메인스레드. deps externalize(소비자 번들러가 해석). worker 참조 .ts→.js.
//  2) worker — **self-contained 번들**(noExternal). 소비자의 *워커 컨텍스트*는 bare import(comlink·laz-perf·
//     copc·proj4·p-retry·내부 chunk)를 못 해석해 worker eval 이 실패한다 → 모든 dep 을 워커 안으로 번들해 회피.
//     wasm 만 외부(상대 URL, dist/laz-perf.wasm).

function rewrite(file: string, edits: Array<[RegExp, string]>): void {
  let s = readFileSync(file, 'utf8');
  for (const [re, to] of edits) s = s.replace(re, to);
  writeFileSync(file, s);
}

// laz-perf 의 Vite 전용 `?url` → 번들러-무관 상대 URL (소비자 번들러가 dist/laz-perf.wasm emit).
const wasmUrlPlugin = {
  name: 'wasm-url',
  setup(build: { onResolve: Function; onLoad: Function }) {
    build.onResolve({ filter: /\.wasm\?url$/ }, (a: { path: string }) => ({ path: a.path, namespace: 'wasm-url' }));
    build.onLoad({ filter: /.*/, namespace: 'wasm-url' }, () => ({
      contents: "export default new URL('./laz-perf.wasm', import.meta.url).href;",
      loader: 'js',
    }));
  },
};

export default defineConfig([
  {
    entry: ['src/index.ts'],
    format: ['esm'],
    dts: true,
    clean: true,
    target: 'es2022',
    platform: 'browser',
    onSuccess: async () => {
      copyFileSync('public/copc-sw.js', 'dist/copc-sw.js');
      rewrite('dist/index.js', [[/decode\.worker\.ts/g, 'decode.worker.js']]);
    },
  },
  {
    entry: ['src/decode.worker.ts'],
    format: ['esm'],
    dts: false,
    clean: false,
    target: 'es2022',
    platform: 'browser',
    noExternal: [/.*/], // 모든 dep 을 워커에 번들 (self-contained)
    esbuildPlugins: [wasmUrlPlugin as never],
    onSuccess: async () => {
      copyFileSync('node_modules/laz-perf/lib/web/laz-perf.wasm', 'dist/laz-perf.wasm');
      // 플러그인이 `?url` 을 못 잡은 경우 대비 후처리
      rewrite('dist/decode.worker.js', [
        [
          /import\s+\w+\s+from\s+["'][^"']*laz-perf\.wasm\?url["'];?/,
          "const lazPerfWasmUrl = new URL('./laz-perf.wasm', import.meta.url).href;",
        ],
      ]);
    },
  },
]);
