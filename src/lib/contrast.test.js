import assert from 'node:assert/strict';

function lin(channel) {
  const c = channel / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function lum(hex) {
  const n = parseInt(hex.slice(1), 16);
  const r = lin((n >> 16) & 255);
  const g = lin((n >> 8) & 255);
  const b = lin(n & 255);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function ratio(a, b) {
  const left = lum(a);
  const right = lum(b);
  const hi = Math.max(left, right);
  const lo = Math.min(left, right);
  return (hi + 0.05) / (lo + 0.05);
}

const pairs = [
  ['#1c1915', '#f4f1ea'],
  ['#3a352f', '#f4f1ea'],
  ['#514c45', '#f4f1ea'],
  ['#fff8f4', '#6e301c'],
  ['#6d2430', '#f4f1ea'],
  ['#1c1915', '#fbf9f4'],
  ['#514c45', '#fbf9f4'],
  ['#fff8f4', '#5c2818'],
  ['#f4f1ea', '#1c1915'],
];

for (const [a, b] of pairs) {
  assert.ok(ratio(a, b) >= 4.5, `${a} on ${b} is ${ratio(a, b).toFixed(2)}`);
}

console.log('contrast ok');
