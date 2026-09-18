'use strict';
const assert = require('assert');
const { squeezeJson } = require('../src/json-squeeze.js');

let passed = 0, failed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`PASS: ${name}`);
  } catch (e) {
    failed++;
    console.log(`FAIL: ${name} -> ${e.stack}`);
  }
}

test('squeezeJson returns unchanged when under budget', () => {
  const obj = { a: 1, b: 'hello' };
  const res = squeezeJson(obj, { maxTokens: 1000 });
  assert.deepStrictEqual(JSON.parse(res.output), obj);
  assert.strictEqual(res.truncated, false);
});

test('squeezeJson prioritizes error/status keys over low-priority ones', () => {
  const obj = {
    _internalId: 'x'.repeat(2000),
    timestamp: '2024-01-01T00:00:00Z',
    error: 'payment failed: card declined',
    status: 500,
    users: Array.from({ length: 500 }, (_, i) => ({ id: i, name: `user${i}`, bio: 'x'.repeat(50) }))
  };
  const res = squeezeJson(obj, { maxTokens: 200 });
  const parsed = JSON.parse(res.output);
  assert.ok(parsed.error, 'error key should survive');
  assert.strictEqual(parsed.status, 500, 'status key should survive');
  assert.ok(res.outputTokens <= 250, `outputTokens ${res.outputTokens} should be near budget`);
  assert.ok(res.truncated, 'should mark as truncated');
});

test('squeezeJson keeps head+tail of long arrays with omission marker', () => {
  const arr = Array.from({ length: 1000 }, (_, i) => i);
  const res = squeezeJson({ items: arr }, { maxTokens: 100, arrayEdgeItems: 2 });
  const parsed = JSON.parse(res.output);
  assert.ok(Array.isArray(parsed.items));
  const hasMarker = parsed.items.some(x => typeof x === 'string' && x.includes('omitted'));
  assert.ok(hasMarker, 'expected omission marker in array');
});

test('squeezeJson truncates very long string values', () => {
  const obj = { message: 'x'.repeat(10000) };
  const res = squeezeJson(obj, { maxTokens: 50 });
  const parsed = JSON.parse(res.output);
  assert.ok(parsed.message.includes('truncated'));
  assert.ok(parsed.message.length < 500);
});

test('squeezeJson accepts JSON string input directly', () => {
  const jsonStr = JSON.stringify({ a: 'x'.repeat(5000), error: 'boom' });
  const res = squeezeJson(jsonStr, { maxTokens: 30 });
  const parsed = JSON.parse(res.output);
  assert.ok(parsed.error === 'boom');
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
