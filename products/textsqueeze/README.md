# textsqueeze

Reduce logs, JSON dumps, and long text toward an estimated LLM token budget —
keeps errors/warnings and unique content, drops noise and duplicate lines.
Also strips ANSI color codes and collapses repeated CI progress-bar/percent
spam, so pasting raw CI build logs (GitHub Actions, GitLab CI, Jenkins) into
a prompt doesn't waste tokens on escape codes and download percentages.

No API calls, no ML model, no network dependency. Pure deterministic
heuristics. Performance on very large files has not been measured.

## Why

Pasting a 5,000-line log file (or a huge API JSON response) into an LLM
prompt burns tokens (= money) on repeated boilerplate while the one `error`
field that actually matters might get truncated or buried. CI logs add
their own noise on top: ANSI color codes, timestamp prefixes on every line,
and 50-line runs of `Downloading... 12%` / `13%` / `14%` ... `textsqueeze`
scores content by importance, keeps what matters, deduplicates repeats
(including timestamp-prefixed duplicates), strips ANSI codes, collapses
progress-bar spam, and compresses long stack traces / long arrays — all
before you pay for those tokens.

## Try from source

```bash
git clone https://github.com/gigandite/automaton-products.git
cd automaton-products/products/textsqueeze
node bin/textsqueeze.js --help
node bin/textsqueeze.js app.log --max-tokens=1000
```

This package is not published on npm. The examples below use `textsqueeze`
as shorthand for `node bin/textsqueeze.js`.

## Usage

### Text / log mode (default)

```bash
# From a file
textsqueeze app.log --max-tokens=1000

# From stdin
cat app.log | textsqueeze --max-tokens=500 --stats

# A raw CI build log (ANSI colors + progress-bar spam handled automatically)
textsqueeze ci-build.log --max-tokens=800 --stats
```

### JSON mode (structure-aware)

For JSON input (API responses, structured logs), use `--json-mode` to prune
by key priority and array edges instead of line-based squeezing:

```bash
textsqueeze response.json --json-mode --max-tokens=500 --stats --pretty
```

- Keys like `error`, `status`, `message`, `code`, `stack` are kept first.
- Keys like `_internalId`, `timestamp`, `createdAt` are deprioritized/dropped first.
- Long arrays keep the first/last few items and mark the omitted middle.
- Long string values are truncated with a `[truncated N chars]` marker.

### Options

- `--max-tokens=N` — target token budget (default: 2000)
- `--keep-frames=N` — stack trace frames to keep per exception, text mode only (default: 3)
- `--no-dedupe` — disable duplicate-line collapsing, text mode only
- `--no-strip-ansi` — keep raw ANSI color/escape codes instead of stripping them, text mode only
- `--no-collapse-progress` — do not collapse repeated progress-bar/percent lines, text mode only
- `--json-mode` — treat input as JSON and prune structurally (see above)
- `--array-edge=N` — items to keep at each end of long arrays, json-mode only (default: 3)
- `--pretty` — pretty-print JSON output, json-mode only
- `--stats` — print original/output token counts and compression ratio to stderr
- `--json` — output result as a JSON envelope `{ output, originalTokens, outputTokens, ratio, ... }`
  (independent of `--json-mode`; this controls the CLI's own output format)

## How it works

### Text mode
1. **ANSI stripping**: color/escape codes (`\x1b[...m`) common in CI console
   output are removed before scoring, so they don't inflate line length or
   break duplicate detection.
2. **Progress-bar collapsing**: consecutive lines matching a percentage
   (`45%`), byte-count (`12MB/103MB`), or ASCII bar (`###----`) pattern are
   collapsed into a single line, annotated `(progress line xN, collapsed)`.
3. **Dedupe**: identical lines — after stripping common timestamp prefixes
   like `2024-01-15T10:23:45.123Z` or `[10:23:45]` — are collapsed to one,
   annotated `(xN repeated)`.
4. **Stack trace compression**: consecutive `at ...` frames beyond the first
   N are replaced with `... (stack trace truncated)`.
5. **Scoring**: each remaining line is scored — `error`/`exception`/`fatal`
   score high, `warn` scores medium, separator lines, huge blobs, and
   progress-bar lines score low.
6. **Budget-fit selection**: highest-scoring lines are kept, in original
   order, until the token budget is filled. Gaps are marked `[...omitted...]`.

### JSON mode
1. **Key scoring**: object keys matching common "important" patterns
   (`error`, `status`, `message`, `code`, `stack`, ...) are kept first; keys
   matching common "noise" patterns (`_*`, `*Id`, `timestamp`, ...) are
   deprioritized.
2. **Recursive budget allocation**: each nested value gets a token sub-budget;
   objects/arrays/strings are pruned recursively until the whole structure
   fits.
3. **Array edge-keeping**: long arrays keep the first/last N items and insert
   an `"...[K items omitted]..."` marker for the rest.
4. **String truncation**: long string values are cut with a
   `...[truncated N chars]` marker.

Token counts are estimated with a ~4-chars-per-token heuristic — no
external tokenizer dependency, so it works offline and instantly.

## Examples

**Text mode**: 3,000 routine `INFO` lines + 1 `ERROR` + 20-frame stack trace
+ 1 `WARN` (~41,000 estimated tokens):

```
$ textsqueeze app.log --max-tokens=300 --stats
...
[textsqueeze] original=41083tok output=287tok ratio=0.7% dropped_lines=2985
```

**CI log mode**: a build log with ANSI-colored output and a 50-line
`Downloading... N%` progress run, plus one real failure:

```
$ textsqueeze ci-build.log --max-tokens=200 --stats
Downloading dependency... 100%  (progress line x50, collapsed)
ERROR: build failed
[textsqueeze] original=612tok output=14tok ratio=2.3% dropped_lines=1
```

**JSON mode**: API error response with a 3000-char internal trace ID and a
300-item user array (~13,000 estimated tokens):

```
$ textsqueeze response.json --json-mode --max-tokens=200 --stats
...
[textsqueeze] original=12970tok output=243tok ratio=1.9% truncated=true
```

Output keeps `status` and `error`, drops the noisy internal trace ID
entirely, and keeps the first few + last few array items with an omission
marker for the rest.

## Status and limitations

Experimental v0.3 source release. 20 local tests pass (5 text-mode + 5
json-mode + 9 CI-log/ANSI/progress-bar + 1 browser-core integration). No real customer or revenue
validation has been completed. Token counts are character-based estimates,
not provider tokenization or verified cost savings. The target is not a
hard limit: omission markers and JSON formatting can exceed it. Content may
be lost, including important information; always keep originals and review
the output. A pay-what-you-want Support Edition is available on
[Gumroad](https://gigandite.gumroad.com/l/textsqueeze-support); the same MIT
source remains free on GitHub.

## License

MIT

## Direct sponsor advertising

One privacy-preserving text sponsor slot is available for developer-relevant
products. The introductory price is US$10 for 30 days, with no pageview,
click, conversion, or sales guarantee. See the public
[advertising terms and application](https://automaton-products.pages.dev/advertise.html).
