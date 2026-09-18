#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { squeeze } = require('../src/index.js');
const { squeezeJson } = require('../src/json-squeeze.js');

function printHelp() {
  console.log(`textsqueeze - squeeze text/logs/JSON to fit an LLM token budget

Usage:
  textsqueeze [file] --max-tokens=2000 [--no-dedupe] [--keep-frames=3] [--stats]
  cat file.log | textsqueeze --max-tokens=1000
  textsqueeze data.json --json-mode --max-tokens=500
  textsqueeze ci-build.log --max-tokens=800 --stats   # strips ANSI colors + collapses progress bars automatically

Options:
  --max-tokens=N     Target token budget (default: 2000)
  --keep-frames=N    Stack trace frames to keep per trace, text mode only (default: 3)
  --no-dedupe        Do not collapse duplicate lines (text mode only)
  --no-strip-ansi    Keep raw ANSI color/escape codes instead of stripping them (text mode only)
  --no-collapse-progress  Do not collapse repeated progress-bar/percent lines (text mode only)
  --json-mode        Treat input as JSON; prune by key priority/array edges
                      instead of line-based squeezing (structure-aware)
  --array-edge=N     Items to keep at each end of long arrays, json-mode only (default: 3)
  --pretty           Pretty-print JSON output, json-mode only
  --stats            Print stats to stderr (original/output tokens, ratio)
  --json             Output result as a JSON envelope (output + stats) instead
                      of raw text. Independent of --json-mode.
  -h, --help         Show this help
`);
}

function parseArgs(argv) {
  const args = { _: [] };
  for (const raw of argv) {
    if (raw === '-h' || raw === '--help') { args.help = true; continue; }
    if (raw === '--no-dedupe') { args.dedupe = false; continue; }
    if (raw === '--no-strip-ansi') { args.stripAnsi = false; continue; }
    if (raw === '--no-collapse-progress') { args.collapseProgress = false; continue; }
    if (raw === '--stats') { args.stats = true; continue; }
    if (raw === '--json') { args.json = true; continue; }
    if (raw === '--json-mode') { args.jsonMode = true; continue; }
    if (raw === '--pretty') { args.pretty = true; continue; }
    const m = raw.match(/^--([a-z-]+)=(.+)$/);
    if (m) { args[m[1]] = m[2]; continue; }
    args._.push(raw);
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { printHelp(); process.exit(0); }

  const maxTokens = args['max-tokens'] ? parseInt(args['max-tokens'], 10) : 2000;
  const keepFrames = args['keep-frames'] ? parseInt(args['keep-frames'], 10) : 3;
  const arrayEdge = args['array-edge'] ? parseInt(args['array-edge'], 10) : 3;
  const dedupe = args.dedupe !== false;
  const stripAnsiCodes = args.stripAnsi !== false;
  const collapseProgress = args.collapseProgress !== false;

  const filePath = args._[0];

  const readInput = () => {
    if (filePath) {
      return fs.readFileSync(path.resolve(filePath), 'utf8');
    }
    if (process.stdin.isTTY) {
      printHelp();
      process.exit(1);
    }
    return fs.readFileSync(0, 'utf8');
  };

  const input = readInput();

  let result;
  if (args.jsonMode) {
    try {
      result = squeezeJson(input, { maxTokens, arrayEdgeItems: arrayEdge, pretty: !!args.pretty });
    } catch (e) {
      console.error(`[textsqueeze] --json-mode: failed to parse input as JSON: ${e.message}`);
      process.exit(1);
    }
  } else {
    result = squeeze(input, { maxTokens, dedupe, keepStackFrames: keepFrames, stripAnsiCodes, collapseProgress });
  }

  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(result.output);
    if (args.stats) {
      const droppedInfo = args.jsonMode
        ? `truncated=${result.truncated}`
        : `dropped_lines=${result.droppedLines}`;
      console.error(`\n[textsqueeze] original=${result.originalTokens}tok output=${result.outputTokens}tok ratio=${(result.ratio * 100).toFixed(1)}% ${droppedInfo}`);
    }
  }
}

main();
