'use strict';

// Rough token estimate: ~4 chars per token (good enough heuristic, no API dependency).
function estimateTokens(str) {
  if (!str) return 0;
  return Math.ceil(str.length / 4);
}

function charsForTokenBudget(tokens) {
  return tokens * 4;
}

// Strip ANSI escape codes (color codes, cursor movement) common in CI logs
// (GitHub Actions, GitLab CI, Jenkins console output, etc).
const ANSI_RE = /\x1b\[[0-9;?]*[a-zA-Z]/g;
function stripAnsi(line) {
  return line.replace(ANSI_RE, '');
}

// Strip common CI timestamp prefixes so duplicate-detection and scoring see
// the actual content instead of a unique-per-line timestamp.
// Handles: "2024-01-15T10:23:45.123Z ", "[10:23:45] ", "10:23:45.123 "
const TIMESTAMP_PREFIX_RE = /^(\[?\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(\.\d+)?Z?\]?\s+|\[\d{2}:\d{2}:\d{2}(\.\d+)?\]\s+)/;
function stripTimestampPrefix(line) {
  return line.replace(TIMESTAMP_PREFIX_RE, '');
}

// Detect CI progress-bar / spinner noise lines that repeat with only a
// percentage or byte-count changing, e.g.:
//   "Downloading... 12%"  "Downloading... 45%"  "Downloading... 98%"
//   "##########-----  62.3MB/103MB"
const PROGRESS_RE = /(\d+%|\d+(\.\d+)?\s?[KMG]?B\/\d+(\.\d+)?\s?[KMG]?B|^[#=\-.\s]{10,}$)/;
function isProgressLine(line) {
  return PROGRESS_RE.test(line.trim());
}

// Normalize a line for duplicate/progress-group detection: strip timestamp,
// ansi codes, and any digits (so "62%" and "98%" group together).
function normalizeForGrouping(line) {
  return stripTimestampPrefix(stripAnsi(line)).replace(/\d+(\.\d+)?/g, '#').trim();
}

// Split text into logical lines, scoring each line by "informativeness".
// Heuristics (no ML, no network calls — deterministic and fast):
//  - JSON keys/error/warn/exception lines score higher
//  - Duplicate/near-duplicate lines get suppressed after first occurrence
//  - Very long repeated whitespace/separators score lower
//  - Stack trace frames beyond the first few are compressed
//  - CI progress-bar spam is collapsed to one summary line
function scoreLine(line) {
  let score = 1;
  const trimmed = line.trim();
  if (!trimmed) return 0;
  if (/error|exception|fail|fatal|critical/i.test(trimmed)) score += 5;
  if (/warn/i.test(trimmed)) score += 2;
  if (/^\s*at\s+/.test(line)) score -= 0.5; // stack frame noise
  if (/^-{3,}|^={3,}|^\*{3,}/.test(trimmed)) score -= 1; // separators
  if (trimmed.length > 300) score -= 1; // very long lines often blobs
  if (isProgressLine(trimmed)) score -= 3; // progress bars / download % spam
  return score;
}

function squeeze(text, opts = {}) {
  const {
    maxTokens = 2000,
    dedupe = true,
    keepStackFrames = 3,
    stripAnsiCodes = true,
    collapseProgress = true
  } = opts;

  const originalTokens = estimateTokens(text);
  let rawLines = text.split(/\r?\n/);

  // Preprocess: strip ANSI color codes (CI console output noise).
  if (stripAnsiCodes) {
    rawLines = rawLines.map(stripAnsi);
  }

  // Collapse consecutive progress-bar / spinner lines into a single
  // representative line (keeps the last one, which usually shows the
  // final % or completed size) — common in CI build/download output.
  if (collapseProgress) {
    const collapsed = [];
    let progressRun = [];
    const flushRun = () => {
      if (progressRun.length === 0) return;
      if (progressRun.length === 1) {
        collapsed.push(progressRun[0]);
      } else {
        collapsed.push(`${progressRun[progressRun.length - 1]}  (progress line x${progressRun.length}, collapsed)`);
      }
      progressRun = [];
    };
    for (const line of rawLines) {
      if (isProgressLine(line.trim())) {
        progressRun.push(line);
      } else {
        flushRun();
        collapsed.push(line);
      }
    }
    flushRun();
    rawLines = collapsed;
  }

  const lines = rawLines;

  // Compress consecutive stack trace frames beyond keepStackFrames.
  const compressedLines = [];
  let stackRun = 0;
  for (const line of lines) {
    if (/^\s*at\s+/.test(line)) {
      stackRun += 1;
      if (stackRun <= keepStackFrames) {
        compressedLines.push(line);
      } else if (stackRun === keepStackFrames + 1) {
        compressedLines.push('  ... (stack trace truncated)');
      }
      continue;
    }
    stackRun = 0;
    compressedLines.push(line);
  }

  // Dedupe: identical lines (after stripping timestamp prefixes, since CI
  // logs often prefix every line with a unique timestamp) collapse to one,
  // annotated with repeat count.
  let entries = compressedLines.map(line => ({ line, dupCount: 0 }));
  if (dedupe) {
    const deduped = [];
    let prevKey = null;
    for (const entry of entries) {
      const key = normalizeForGrouping(entry.line);
      if (key && key === prevKey && deduped.length > 0) {
        deduped[deduped.length - 1].dupCount += 1;
      } else {
        deduped.push({ ...entry });
        prevKey = key;
      }
    }
    entries = deduped;
  }

  // annotate dup counts back into visible text
  entries = entries.map(e => {
    if (e.dupCount > 0) {
      return { ...e, line: `${e.line}  (x${e.dupCount + 1} repeated)` };
    }
    return e;
  });

  const budgetChars = charsForTokenBudget(maxTokens);

  // If it already fits, return as-is (post dedupe/compress).
  const joinedAll = entries.map(e => e.line).join('\n');
  if (estimateTokens(joinedAll) <= maxTokens) {
    return {
      output: joinedAll,
      originalTokens,
      outputTokens: estimateTokens(joinedAll),
      ratio: originalTokens ? estimateTokens(joinedAll) / originalTokens : 1,
      droppedLines: 0
    };
  }

  // Score and rank lines, keep highest scoring lines that fit budget,
  // preserving original order for readability.
  const scored = entries.map((e, idx) => ({ idx, line: e.line, score: scoreLine(e.line) }));
  const sorted = [...scored].sort((a, b) => b.score - a.score);

  let used = 0;
  const keep = new Set();
  for (const item of sorted) {
    const cost = estimateTokens(item.line) + 1;
    if (used + cost > maxTokens) continue;
    keep.add(item.idx);
    used += cost;
  }

  const keptSorted = [...keep].sort((a, b) => a - b);
  const outLines = [];
  let lastIdx = -1;
  let dropped = 0;
  for (const idx of keptSorted) {
    if (lastIdx !== -1 && idx !== lastIdx + 1) {
      outLines.push('  [...omitted...]');
    }
    outLines.push(scored[idx].line);
    lastIdx = idx;
  }
  dropped = entries.length - keptSorted.length;

  const output = outLines.join('\n');
  return {
    output,
    originalTokens,
    outputTokens: estimateTokens(output),
    ratio: originalTokens ? estimateTokens(output) / originalTokens : 1,
    droppedLines: dropped
  };
}

module.exports = { squeeze, estimateTokens, stripAnsi, isProgressLine };
