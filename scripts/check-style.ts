import { rampStyle } from '../src/copc-style';
function assert(c: unknown, m: string): void { if (!c) { console.error('FAIL: ' + m); process.exit(1); } }
const style = rampStyle('Intensity', [0, 65535]);
assert(style && (style as { color?: unknown }).color, 'rampStyle returns a style with a color expression');
// Cesium normalizes color into a ConditionsExpression; the original conditions are preserved on the
// public `style.style` options object (style.color is private-internal). Assert structure there.
const conditions = (style.style as { color?: { conditions?: unknown } }).color?.conditions;
assert(Array.isArray(conditions), 'color.conditions is an array');
assert((conditions as unknown[]).length === 6, 'conditions = palette.length(5) + catch-all = 6');
console.log('PASS style');
process.exit(0);
