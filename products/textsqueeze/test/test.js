'use strict';
const assert = require('assert');
const { squeeze, estimateTokens } = require('../src/index.js');

let passed = 0, failed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`PASS: ${name}`);
  } catch (e) {
    failed++;
    console.log(`FAIL: ${name} -> ${e.message}`);
  }
}

test('estimateTokens basic', () => {
  assert.strictEqual(estimateTokens(''), 0);
  assert.strictEqual(estimateTokens('abcd'), 1);
  assert.strictEqual(estimateTokens('abcdefgh'), 2);
});

test('squeeze returns input unchanged if under budget', () => {
  const input = 'line one\nline two\nline three';
  const res = squeeze(input, { maxTokens: 1000 });
  assert.strictEqual(res.output, input);
  assert.strictEqual(res.droppedLines, 0);
});

test('squeeze deduplicates repeated lines', () => {
  const input = Array.from({ length: 50 }, () => 'repeated log line here').join('\n');
  const res = squeeze(input, { maxTokens: 1000 });
  const occurrences = res.output.split('\n').filter(l => l.includes('repeated log line here')).length;
  assert.strictEqual(occurrences, 1);
  assert.ok(res.output.includes('x50 repeated'));
});

test('squeeze respects token budget on large input', () => {
  const lines = [];
  for (let i = 0; i < 2000; i++) {
    lines.push(`INFO: routine log entry number ${i} with some padding text here to add length`);
  }
  lines.push('ERROR: critical failure in payment processor, transaction rolled back');
  const input = lines.join('\n');
  const res = squeeze(input, { maxTokens: 500 });
  assert.ok(res.outputTokens <= 550, `outputTokens ${res.outputTokens} should be close to budget 500`);
  assert.ok(res.output.includes('ERROR: critical failure'), 'important ERROR line should be prioritized and kept');
  assert.ok(res.ratio < 1, 'output should be smaller than original');
});

test('squeeze compresses long stack traces, keeping first N frames', () => {
  const frames = Array.from({ length: 30 }, (_, i) => `    at someFunction${i} (/app/file${i}.js:${i}:1)`);
  const input = ['Error: something broke', ...frames].join('\n');
  const res = squeeze(input, { maxTokens: 1000, keepStackFrames: 3 });
  const frameCount = res.output.split('\n').filter(l => /^\s*at\s+/.test(l)).length;
  assert.ok(frameCount <= 3, `expected <=3 stack frames, got ${frameCount}`);
  assert.ok(res.output.includes('truncated'));
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
