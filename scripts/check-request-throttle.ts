import { RequestScheduler } from 'cesium';
import {
  acquireContentServerThrottle,
  releaseContentServerThrottle,
  setContentServerThrottle,
} from '../src/copc-tileset';

const key = 'example.test:443';
const originalLocation = globalThis.location;
Object.defineProperty(globalThis, 'location', {
  configurable: true,
  value: { host: 'example.test', protocol: 'https:' },
});

const map = RequestScheduler.requestsByServer;
const hadPrior = Object.prototype.hasOwnProperty.call(map, key);
const prior = map[key];
let failed = false;

try {
  map[key] = 11;
  setContentServerThrottle(6);
  if (map[key] !== 6) throw new Error(`6 설정 실패: ${map[key]}`);
  setContentServerThrottle(0);
  if (map[key] !== 11) throw new Error(`0 escape hatch가 이전 값을 복원하지 않음: ${map[key]}`);

  acquireContentServerThrottle('a', 6);
  acquireContentServerThrottle('b', 12);
  if (map[key] !== 6) throw new Error(`다중 세션 보수적 상한 실패: ${map[key]}`);
  releaseContentServerThrottle('a');
  if (map[key] !== 12) throw new Error(`세션 a 해제 후 b 상한 복귀 실패: ${map[key]}`);
  releaseContentServerThrottle('b');
  if (map[key] !== 11) throw new Error(`마지막 세션 해제 후 원래 값 복원 실패: ${map[key]}`);
} catch (error) {
  failed = true;
  console.error((error as Error).message);
} finally {
  if (hadPrior) map[key] = prior;
  else delete map[key];
  Object.defineProperty(globalThis, 'location', { configurable: true, value: originalLocation });
}

console.log(failed ? 'REQUEST THROTTLE FAIL' : 'REQUEST THROTTLE PASS');
process.exit(failed ? 1 : 0);
