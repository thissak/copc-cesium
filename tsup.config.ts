import { defineConfig } from 'tsup';
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs';

// 소스는 dev(Vite) 친화 형태 유지(`...laz-perf.wasm?url`, `new Worker(new URL('./decode.worker.ts',…))`);
// 라이브러리 출하용 변환은 빌드 후처리로만 한다 → demo(`npm run dev`)는 무영향.
// (esbuild 플러그인 onResolve 는 tsup 의 dep-external 처리에 선점당해 `?url` 을 못 잡으므로 후처리 rewrite 사용.)
function rewrite(file: string, edits: Array<[RegExp, string]>): void {
  let s = readFileSync(file, 'utf8');
  for (const [re, to] of edits) s = s.replace(re, to);
  writeFileSync(file, s);
}

export default defineConfig({
  entry: ['src/index.ts', 'src/decode.worker.ts'],
  format: ['esm'],
  dts: true,
  clean: true,
  target: 'es2022',
  // deps/peerDeps(cesium·copc·laz-perf·comlink·p-retry·proj4)는 tsup 가 자동 externalize.
  onSuccess: async () => {
    // 1) wasm 을 dist 에 두어 worker 의 상대 URL 이 해석되게 (소비자 번들러가 emit).
    copyFileSync('node_modules/laz-perf/lib/web/laz-perf.wasm', 'dist/laz-perf.wasm');
    // 2) 서비스워커 배포물(소비자가 origin 에 복사해 서빙).
    copyFileSync('public/copc-sw.js', 'dist/copc-sw.js');
    // 3) worker 참조 .ts→.js.
    rewrite('dist/index.js', [[/decode\.worker\.ts/g, 'decode.worker.js']]);
    // 4) Vite 전용 `?url` wasm import → 번들러-무관 상대 URL(dist/laz-perf.wasm).
    rewrite('dist/decode.worker.js', [
      [
        /import\s+lazPerfWasmUrl\s+from\s+["'][^"']*laz-perf\.wasm\?url["'];?/,
        "const lazPerfWasmUrl = new URL('./laz-perf.wasm', import.meta.url).href;",
      ],
    ]);
  },
});
