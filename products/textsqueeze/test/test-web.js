'use strict';

const assert = require('assert');

global.window = global;
require('../web/textsqueeze-core.js');

const lines = [];
for (let i = 1; i <= 4; i++) {
  lines.push(`2026-01-01T00:00:0${i}Z Downloading dependencies... ${i * 10}%`);
}
lines.push('\x1b[31m2026-01-01T00:00:05Z ERROR build failed\x1b[0m');

const result = global.TextSqueeze.squeeze(lines.join('\n'), { maxTokens: 999 });
assert.ok(result.output.includes('(progress line x4, collapsed)'),
  'timestamped progress lines should collapse in the browser build');
assert.ok(result.output.includes('ERROR build failed'),
  'the browser build should keep the final error');
assert.ok(!result.output.includes('\x1b['),
  'the browser build should strip ANSI escapes by default');

const preserved = global.TextSqueeze.squeeze('\x1b[31mERROR\x1b[0m', {
  maxTokens: 999,
  stripAnsi: false,
  collapseProgress: false
});
assert.ok(preserved.output.includes('\x1b['),
  'the browser build should preserve ANSI escapes when disabled');

console.log('PASS: browser CI-log core loads and applies its public options');
