// textsqueeze-core.js
// Browser-compatible copy of the core squeeze logic from src/index.js and
// src/json-squeeze.js. Kept logically identical (no server calls, no
// dependencies). This runs 100% client-side; nothing you paste here is
// ever sent anywhere.
(function (global) {
  'use strict';

  // ---- shared: token estimate ----
  function estimateTokens(str) {
    if (!str) return 0;
    return Math.ceil(str.length / 4);
  }

  function charsForTokenBudget(tokens) {
    return tokens * 4;
  }

  // ---- CI log helpers (mirrors src/index.js v0.3.0) ----
  function stripAnsi(str) {
    return str.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
  }

  var TIMESTAMP_PREFIX_RE = /^(\[?\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(\.\d+)?Z?\]?\s*|\[\d{2}:\d{2}:\d{2}\]\s*)/;
  function stripTimestampPrefix(line) {
    return line.replace(TIMESTAMP_PREFIX_RE, '');
  }

  function isProgressLine(line) {
    var t = line.trim();
    if (!t) return false;
    if (/^\d{1,3}%(\s|$)/.test(t)) return true;
    if (/\.\.\.\s*\d{1,3}%\s*$/.test(t)) return true;
    if (/\d{1,3}%/.test(t) && /(download|upload|progress|loading|extracting|compiling|building)/i.test(t)) return true;
    if (/^\[?#+[-\s]*\]?\s*\d{0,3}%?$/.test(t)) return true;
    if (/^\d+(\.\d+)?\s*(KB|MB|GB)\s*\/\s*\d+(\.\d+)?\s*(KB|MB|GB)/i.test(t)) return true;
    return false;
  }

  // ---- text/log mode (mirrors src/index.js) ----
  function scoreLine(line) {
    let score = 1;
    const trimmed = line.trim();
    if (!trimmed) return 0;
    if (/error|exception|fail|fatal|critical/i.test(trimmed)) score += 5;
    if (/warn/i.test(trimmed)) score += 2;
    if (/^\s*at\s+/.test(line)) score -= 0.5;
    if (/^-{3,}|^={3,}|^\*{3,}/.test(trimmed)) score -= 1;
    if (trimmed.length > 300) score -= 1;
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

  function compressStackTraces(lines, keepFrames) {
    if (keepFrames == null) keepFrames = 3;
    const out = [];
    let frameRun = 0;
    for (const line of lines) {
      const text = line.line != null ? line.line : line;
      const isFrame = /^\s*at\s+/.test(text);
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

  function squeeze(input, opts) {
    opts = opts || {};
    const maxTokens = opts.maxTokens || 2000;
    const doDedupe = opts.dedupe !== false;
    const keepFrames = opts.keepStackFrames != null ? opts.keepStackFrames : 3;

    const originalTokens = estimateTokens(input);
    const rawLines = input.split(/\r?\n/);

    let entries = rawLines.map(function (l) { return { line: l, dupCount: 0 }; });
    if (doDedupe) entries = dedupeLines(rawLines);
    entries = compressStackTraces(entries, keepFrames);

    entries = entries.map(function (e) {
      if (e.dupCount > 0) {
        return { line: e.line + '  (x' + (e.dupCount + 1) + ' repeated)', dupCount: e.dupCount };
      }
      return e;
    });

    const joinedAll = entries.map(function (e) { return e.line; }).join('\n');
    if (estimateTokens(joinedAll) <= maxTokens) {
      return {
        output: joinedAll,
        originalTokens: originalTokens,
        outputTokens: estimateTokens(joinedAll),
        ratio: originalTokens ? estimateTokens(joinedAll) / originalTokens : 1,
        droppedLines: 0
      };
    }

    const scored = entries.map(function (e, idx) { return { idx: idx, line: e.line, score: scoreLine(e.line) }; });
    const sorted = scored.slice().sort(function (a, b) { return b.score - a.score; });

    let used = 0;
    const keep = new Set();
    for (const item of sorted) {
      const cost = estimateTokens(item.line) + 1;
      if (used + cost > maxTokens) continue;
      keep.add(item.idx);
      used += cost;
    }

    const keptSorted = Array.from(keep).sort(function (a, b) { return a - b; });
    const outLines = [];
    let lastIdx = -1;
    for (const idx of keptSorted) {
      if (lastIdx !== -1 && idx !== lastIdx + 1) {
        outLines.push('  [...omitted...]');
      }
      outLines.push(scored[idx].line);
      lastIdx = idx;
    }
    const dropped = entries.length - keptSorted.length;

    const output = outLines.join('\n');
    return {
      output: output,
      originalTokens: originalTokens,
      outputTokens: estimateTokens(output),
      ratio: originalTokens ? estimateTokens(output) / originalTokens : 1,
      droppedLines: dropped
    };
  }

  // ---- JSON mode (mirrors src/json-squeeze.js) ----
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

  function pruneValue(value, budgetTokens, opts) {
    if (budgetTokens <= 0) return { value: undefined, used: 0, dropped: true };

    if (typeof value === 'string') {
      const tok = estimateTokens(value);
      if (tok <= budgetTokens) return { value: value, used: tok, dropped: false };
      const maxChars = Math.max(0, budgetTokens * 4 - 20);
      const truncated = value.slice(0, maxChars) + '...[truncated ' + (value.length - maxChars) + ' chars]';
      return { value: truncated, used: estimateTokens(truncated), dropped: true };
    }

    if (typeof value === 'number' || typeof value === 'boolean' || value === null) {
      return { value: value, used: estimateTokens(JSON.stringify(value)), dropped: false };
    }

    if (Array.isArray(value)) {
      const total = valueSize(value);
      if (total <= budgetTokens) return { value: value, used: total, dropped: false };

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
      const marker = omittedCount > 0 ? ['...[' + omittedCount + ' items omitted]...'] : [];
      used += estimateTokens(marker.join(''));
      return { value: outHead.concat(marker, outTail), used: used, dropped: omittedCount > 0 };
    }

    if (typeof value === 'object') {
      const entries = Object.entries(value);
      const total = valueSize(value);
      if (total <= budgetTokens) return { value: value, used: total, dropped: false };

      const scored = entries.map(function (pair, idx) { return { k: pair[0], v: pair[1], idx: idx, score: keyScore(pair[0]) }; });
      scored.sort(function (a, b) { return b.score - a.score || a.idx - b.idx; });

      let used = 0;
      let dropped = false;
      const kept = {};
      for (const item of scored) {
        const remaining = budgetTokens - used;
        if (remaining <= 2) { dropped = true; continue; }
        const keyOverhead = estimateTokens('"' + item.k + '":') + 1;
        const r = pruneValue(item.v, remaining - keyOverhead, opts);
        if (r.value === undefined) { dropped = true; continue; }
        kept[item.k] = r.value;
        used += r.used + keyOverhead;
        if (r.dropped) dropped = true;
      }
      const ordered = {};
      for (const pair of entries) {
        if (Object.prototype.hasOwnProperty.call(kept, pair[0])) ordered[pair[0]] = kept[pair[0]];
      }
      return { value: ordered, used: used, dropped: dropped };
    }

    return { value: value, used: 0, dropped: false };
  }

  function squeezeJson(input, opts) {
    opts = opts || {};
    const maxTokens = opts.maxTokens || 2000;
    const arrayEdgeItems = opts.arrayEdgeItems || 3;
    const pretty = !!opts.pretty;

    let parsed, rawStr;
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
      return { output: output, originalTokens: originalTokens, outputTokens: estimateTokens(output), ratio: 1, truncated: false };
    }

    const result = pruneValue(parsed, maxTokens, { arrayEdgeItems: arrayEdgeItems });
    const output = pretty ? JSON.stringify(result.value, null, 2) : JSON.stringify(result.value);
    const outputTokens = estimateTokens(output);
    return {
      output: output,
      originalTokens: originalTokens,
      outputTokens: outputTokens,
      ratio: originalTokens ? outputTokens / originalTokens : 1,
      truncated: result.dropped
    };
  }

  global.TextSqueeze = {
    estimateTokens: estimateTokens,
    squeeze: squeeze,
    squeezeJson: squeezeJson
  };
})(window);
