import { rampStyle } from '../src/copc-style';
function assert(c: unknown, m: string): void { if (!c) { console.error('FAIL: ' + m); process.exit(1); } }
const style = rampStyle('Intensity', [0, 65535]);
assert(style && (style as { color?: unknown }).color, 'rampStyle returns a style with a color expression');
console.log('PASS style');
process.exit(0);
