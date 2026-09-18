'use strict';

const { estimateTokens } = require('./index.js');

// Score a JSON key/value pair by likely importance when debugging or
// summarizing API responses / structured logs.
const HIGH_PRIORITY_KEYS = /^(error|errors|message|msg|status|statusCode|code|exception|stack|fail|failure|reason|detail|details)$/i;
const LOW_PRIORITY_KEYS = /^(_.*|.*Id$|.*_id$|timestamp|createdAt|updatedAt|__.*)$/i;

function keyScore(key) {
  if (HIGH_PRIORITY_KEYS.test(key)) return 5;
  if (LOW_PRIORITY_KEYS.test(key)) return -1;
  return 1;
}

function valueSize(value) {
  return estimateTokens(JSON.stringify(value));
}

// Recursively prune a JSON value to fit within a token budget.
// Strategy:
//  - Objects: keep all high-priority keys fully; for remaining keys, keep
//    as many as fit budget (by original key order), truncate/drop the rest.
//  - Arrays: if array of primitives/objects is long, keep first N + last N
//    items and insert a marker for the omitted middle section.
//  - Strings: truncate long string values with a marker.
function pruneValue(value, budgetTokens, opts) {
  if (budgetTokens <= 0) return { value: undefined, used: 0, dropped: true };

  if (typeof value === 'string') {
    const tok = estimateTokens(value);
    if (tok <= budgetTokens) return { value, used: tok, dropped: false };
    const maxChars = Math.max(0, budgetTokens * 4 - 20);
    const truncated = value.slice(0, maxChars) + `...[truncated ${value.length - maxChars} chars]`;
    return { value: truncated, used: estimateTokens(truncated), dropped: true };
  }

  if (typeof value === 'number' || typeof value === 'boolean' || value === null) {
    return { value, used: estimateTokens(JSON.stringify(value)), dropped: false };
  }

  if (Array.isArray(value)) {
    const total = valueSize(value);
    if (total <= budgetTokens) return { value, used: total, dropped: false };

    const keepEdge = opts.arrayEdgeItems || 3;
    const head = value.slice(0, keepEdge);
    const tail = value.length > keepEdge * 2 ? value.slice(-keepEdge) : [];
    const omittedCount = value.length - head.length - tail.length;

    let used = 0;
    const outHead = [];
    for (const item of head) {
      const remaining = budgetTokens - used;
      if (remaining <= 0) break;
      const r = pruneValue(item, Math.floor(remaining / 2) || 1, opts);
      outHead.push(r.value);
      used += r.used;
    }
    const outTail = [];
    for (const item of tail) {
      const remaining = budgetTokens - used;
      if (remaining <= 0) break;
      const r = pruneValue(item, Math.floor(remaining / 2) || 1, opts);
      outTail.push(r.value);
      used += r.used;
    }
    const marker = omittedCount > 0 ? [`...[${omittedCount} items omitted]...`] : [];
    used += estimateTokens(marker.join(''));
    return { value: [...outHead, ...marker, ...outTail], used, dropped: omittedCount > 0 };
  }

  if (typeof value === 'object') {
    const entries = Object.entries(value);
    const total = valueSize(value);
    if (total <= budgetTokens) return { value, used: total, dropped: false };

    // Sort keys by priority (desc), but keep stable original order among ties.
    const scored = entries.map(([k, v], idx) => ({ k, v, idx, score: keyScore(k) }));
    scored.sort((a, b) => b.score - a.score || a.idx - b.idx);

    let used = 0;
    let dropped = false;
    const kept = {};
    for (const { k, v } of scored) {
      const remaining = budgetTokens - used;
      if (remaining <= 2) { dropped = true; continue; }
      const keyOverhead = estimateTokens(`"${k}":`) + 1;
      const r = pruneValue(v, remaining - keyOverhead, opts);
      if (r.value === undefined) { dropped = true; continue; }
      kept[k] = r.value;
      used += r.used + keyOverhead;
      if (r.dropped) dropped = true;
    }
    // Restore original key order among kept keys.
    const ordered = {};
    for (const [k] of entries) {
      if (Object.prototype.hasOwnProperty.call(kept, k)) ordered[k] = kept[k];
    }
    return { value: ordered, used, dropped };
  }

  return { value, used: 0, dropped: false };
}

/**
 * Squeeze a JSON value/string to fit within a token budget.
 * @param {string|object} input - JSON string or already-parsed value
 * @param {object} opts
 * @param {number} opts.maxTokens - target token budget (default 2000)
 * @param {number} opts.arrayEdgeItems - items to keep at each end of long arrays (default 3)
 * @param {boolean} opts.pretty - pretty-print output JSON (default false)
 * @returns {{ output: string, originalTokens: number, outputTokens: number, ratio: number, truncated: boolean }}
 */
function squeezeJson(input, opts = {}) {
  const maxTokens = opts.maxTokens || 2000;
  const arrayEdgeItems = opts.arrayEdgeItems || 3;
  const pretty = !!opts.pretty;

  let parsed;
  let rawStr;
  if (typeof input === 'string') {
    rawStr = input;
    parsed = JSON.parse(input);
  } else {
    parsed = input;
    rawStr = JSON.stringify(input);
  }

  const originalTokens = estimateTokens(rawStr);
  if (originalTokens <= maxTokens) {
    const output = pretty ? JSON.stringify(parsed, null, 2) : rawStr;
    return { output, originalTokens, outputTokens: estimateTokens(output), ratio: 1, truncated: false };
  }

  const result = pruneValue(parsed, maxTokens, { arrayEdgeItems });
  const output = pretty ? JSON.stringify(result.value, null, 2) : JSON.stringify(result.value);
  const outputTokens = estimateTokens(output);
  return {
    output,
    originalTokens,
    outputTokens,
    ratio: originalTokens ? outputTokens / originalTokens : 1,
    truncated: result.dropped
  };
}

module.exports = { squeezeJson };
