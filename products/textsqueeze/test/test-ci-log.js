'use strict';

const assert = require('assert');
const { squeeze, stripAnsi, isProgressLine } = require('../src/index.js');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`PASS: ${name}`);
    passed++;
  } catch (e) {
    console.log(`FAIL: ${name}`);
    console.log(`  ${e.message}`);
    failed++;
  }
}

test('stripAnsi removes color escape codes', () => {
  const colored = '\x1b[31mERROR\x1b[0m: something failed \x1b[1;32mOK\x1b[0m';
  const clean = stripAnsi(colored);
  assert.strictEqual(clean, 'ERROR: something failed OK');
});

test('isProgressLine detects percentage progress', () => {
  assert.ok(isProgressLine('Downloading package... 45%'));
  assert.ok(isProgressLine('Downloading package... 98%'));
  assert.ok(!isProgressLine('Build succeeded'));
});

test('isProgressLine detects byte-count progress', () => {
  assert.ok(isProgressLine('Fetching  12.3MB/103.0MB'));
  assert.ok(isProgressLine('Fetching  103.0MB/103.0MB'));
});

test('isProgressLine detects ascii progress bars', () => {
  assert.ok(isProgressLine('##########----------'));
  assert.ok(!isProgressLine('--- separator ---'));
});

test('squeeze strips ANSI color codes from output by default', () => {
  const input = '\x1b[32mINFO\x1b[0m starting build\n\x1b[31mERROR\x1b[0m build failed';
  const result = squeeze(input, { maxTokens: 2000 });
  assert.ok(!result.output.includes('\x1b['), 'output should not contain raw ANSI escapes');
  assert.ok(result.output.includes('INFO starting build'));
  assert.ok(result.output.includes('ERROR build failed'));
});

test('squeeze collapses a long run of progress-bar lines into one', () => {
  const lines = [];
  for (let i = 1; i <= 50; i++) {
    lines.push(`Downloading dependency... ${i}%`);
  }
  lines.push('Download complete');
  lines.push('ERROR: build failed');
  const input = lines.join('\n');

  const result = squeeze(input, { maxTokens: 2000 });
  const progressLineCount = result.output.split('\n').filter(l => /Downloading dependency/.test(l)).length;

  assert.strictEqual(progressLineCount, 1, 'all 50 progress lines should collapse to 1');
  assert.ok(result.output.includes('(progress line x50, collapsed)'));
  assert.ok(result.output.includes('ERROR: build failed'));
});

test('squeeze deduplicates timestamp-prefixed repeated lines (CI log style)', () => {
  const input = [
    '2024-01-15T10:00:00.001Z Running task X',
    '2024-01-15T10:00:00.150Z Running task X',
    '2024-01-15T10:00:00.300Z Running task X',
    '2024-01-15T10:00:01.000Z ERROR: task X failed'
  ].join('\n');

  const result = squeeze(input, { maxTokens: 2000 });
  const runningCount = result.output.split('\n').filter(l => /Running task X/.test(l)).length;
  assert.strictEqual(runningCount, 1, 'timestamp-prefixed duplicate lines should collapse');
  assert.ok(result.output.includes('(x3 repeated)'));
  assert.ok(result.output.includes('ERROR: task X failed'));
});

test('squeeze keeps ERROR lines over progress noise when over budget', () => {
  const lines = [];
  for (let i = 1; i <= 200; i++) {
    lines.push(`Fetching pkg${i}... ${i % 100}%`);
  }
  lines.push('FATAL ERROR: dependency resolution failed');
  const input = lines.join('\n');

  const result = squeeze(input, { maxTokens: 50 });
  assert.ok(result.output.includes('FATAL ERROR'), 'fatal error must survive aggressive squeeze');
});

test('squeeze can disable ANSI stripping and progress collapsing via options', () => {
  const input = '\x1b[31mERROR\x1b[0m 50%';
  const result = squeeze(input, { maxTokens: 2000, stripAnsiCodes: false, collapseProgress: false });
  assert.ok(result.output.includes('\x1b['), 'ANSI codes should be preserved when disabled');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
