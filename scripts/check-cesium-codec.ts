import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const project = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const engineRoot = dirname(require.resolve('@cesium/engine/package.json'));
const tilesetSource = readFileSync(join(engineRoot, 'Source/Scene/Cesium3DTileset.js'), 'utf8');
const tileSource = readFileSync(join(engineRoot, 'Source/Scene/Cesium3DTile.js'), 'utf8');
const peer = String(project.peerDependencies?.cesium ?? '');
const minimum = Number(peer.match(/1\.(\d+)/)?.[1] ?? 0);

const constructorContract = tilesetSource.includes('this._runtimeContentCodec = undefined');
const missingTileContract =
  tileSource.includes('_runtimeContentCodec?.missingTilePolicy') &&
  tileSource.includes('isEmptyTile');
const peerContract = minimum >= 142;
const pass = constructorContract && missingTileContract && peerContract;

console.log(JSON.stringify({ peer, constructorContract, missingTileContract, peerContract }, null, 2));
console.log(pass ? 'CESIUM CODEC PASS ✅' : 'CESIUM CODEC FAIL ❌');
process.exit(pass ? 0 : 1);
