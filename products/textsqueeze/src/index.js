'use strict';

// Rough token estimate: ~4 chars per token (good enough heuristic, no API dependency).
function estimateTokens(str) {
  if (!str) return 0;
  return Math.ceil(str.length / 4);
}

function charsForTokenBudget(tokens) {
  return tokens * 4;
}

// Split text into logical lines, scoring each line by "informativeness".
// Heuristics (no ML, no network calls — deterministic and fast):
//  - JSON keys/error/warn/exception lines score higher
//  - Duplicate/near-duplicate lines get suppressed after first occurrence
//  - Very long repeated whitespace/separators score lower
//  - Stack trace frames beyond the first few are compressed
function scoreLine(line) {
  let score = 1;
  const trimmed = line.trim();
  if (!trimmed) return 0;
  if (/error|exception|fail|fatal|critical/i.test(trimmed)) score += 5;
  if (/warn/i.test(trimmed)) score += 2;
  if (/^\s*at\s+/.test(line)) score -= 0.5; // stack frame noise
  if (/^-{3,}|^={3,}|^\*{3,}/.test(trimmed)) score -= 1; // separators
  if (trimmed.length > 300) score -= 1; // very long lines often blobs
  return score;
}

function dedupeLines(lines) {
  const seen = new Map();
  const out = [];
  for (const line of lines) {
    const key = line.trim();
    if (!key) { out.push({ line, dupCount: 0 }); continue; }
    if (seen.has(key)) {
      seen.get(key).dupCount++;
      continue;
    }
    const entry = { line, dupCount: 0 };
    seen.set(key, entry);
    out.push(entry);
  }
  return out;
}

function compressStackTraces(lines, keepFrames = 3) {
  const out = [];
  let frameRun = 0;
  for (const line of lines) {
    const isFrame = /^\s*at\s+/.test(line.line || line);
    const text = line.line || line;
    if (isFrame) {
      frameRun++;
      if (frameRun <= keepFrames) out.push(line);
      else if (frameRun === keepFrames + 1) out.push({ line: '    ... (stack trace truncated)', dupCount: 0 });
    } else {
      frameRun = 0;
      out.push(line);
    }
  }
  return out;
}

/**
 * Squeeze arbitrary text down to fit within a token budget.
 * @param {string} input - raw text (logs, JSON, prose, etc.)
 * @param {object} opts
 * @param {number} opts.maxTokens - target token budget (default 2000)
 * @param {boolean} opts.dedupe - collapse duplicate lines (default true)
 * @param {number} opts.keepStackFrames - stack frames to keep per trace (default 3)
 * @returns {{ output: string, originalTokens: number, outputTokens: number, ratio: number, droppedLines: number }}
 */
function squeeze(input, opts = {}) {
  const maxTokens = opts.maxTokens || 2000;
  const doDedupe = opts.dedupe !== false;
  const keepFrames = opts.keepStackFrames != null ? opts.keepStackFrames : 3;

  const originalTokens = estimateTokens(input);
  const rawLines = input.split(/\r?\n/);

  let entries = rawLines.map(l => ({ line: l, dupCount: 0 }));
  if (doDedupe) entries = dedupeLines(rawLines);
  entries = compressStackTraces(entries, keepFrames);

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

module.exports = { squeeze, estimateTokens };
