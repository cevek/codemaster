// Custom node:test reporter → writes an HTML report of per-file and per-test durations,
// so you can see what eats the wall-clock of a full `npm test` run and target the slow ones.
//
// Usage (paired with `spec` so you still see the normal pass/fail output):
//   node --test \
//     --test-reporter=spec --test-reporter-destination=stdout \
//     --test-reporter=./scripts/test-timing-reporter.mjs --test-reporter-destination=/dev/null \
//     "test/**/*.test.ts"
// Or just: `npm run test:timing`.
// Output: test-timing.html at the repo root (override with CM_TIMING_OUT). git-ignored.

import { writeFileSync } from 'node:fs';
import { relative } from 'node:path';

const OUT = process.env.CM_TIMING_OUT ?? 'test-timing.html';
const cwd = process.cwd();

export default async function* timingReporter(source) {
  /** @type {{file:string,name:string,nesting:number,ms:number,ok:boolean,suite:boolean}[]} */
  const rows = [];
  for await (const event of source) {
    if (event.type !== 'test:pass' && event.type !== 'test:fail') continue;
    const d = event.data ?? {};
    const details = d.details ?? {};
    rows.push({
      file: d.file ? relative(cwd, d.file) : '(unknown)',
      name: String(d.name ?? ''),
      nesting: d.nesting ?? 0,
      ms: Number(details.duration_ms ?? 0),
      ok: event.type === 'test:pass',
      suite: details.type === 'suite',
    });
  }

  // Per-file wall time ≈ sum of the top-level (nesting 0) entries — they run sequentially
  // within a file; a nesting-0 suite's duration already includes its children, so summing
  // only nesting-0 avoids double-counting.
  const byFile = new Map();
  for (const r of rows) {
    const cur = byFile.get(r.file) ?? { file: r.file, ms: 0, tests: 0, fails: 0 };
    if (r.nesting === 0) cur.ms += r.ms;
    if (!r.suite) {
      cur.tests += 1;
      if (!r.ok) cur.fails += 1;
    }
    byFile.set(r.file, cur);
  }
  const files = [...byFile.values()].sort((a, b) => b.ms - a.ms);
  // Slowest individual test cases (leaf tests, not suite aggregates).
  const cases = rows
    .filter((r) => !r.suite)
    .sort((a, b) => b.ms - a.ms)
    .slice(0, 60);
  const totalMs = files.reduce((s, f) => s + f.ms, 0);

  writeFileSync(OUT, renderHtml(files, cases, totalMs));
  yield `\n[test-timing] ${files.length} files, ${rows.filter((r) => !r.suite).length} tests, Σfile ${(totalMs / 1000).toFixed(1)}s → ${OUT}\n`;
}

function bar(ms, max) {
  const pct = max > 0 ? Math.round((ms / max) * 100) : 0;
  return `<div class="bar" style="width:${pct}%"></div>`;
}

function esc(s) {
  return String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);
}

function renderHtml(files, cases, totalMs) {
  const maxFile = files[0]?.ms ?? 1;
  const maxCase = cases[0]?.ms ?? 1;
  const fileRows = files
    .map(
      (f) => `<tr class="${f.fails ? 'fail' : ''}"><td class="ms">${(f.ms / 1000).toFixed(2)}s</td>
      <td class="track">${bar(f.ms, maxFile)}</td><td>${esc(f.file)}</td><td class="n">${f.tests}${f.fails ? ` <span class="x">✗${f.fails}</span>` : ''}</td></tr>`,
    )
    .join('\n');
  const caseRows = cases
    .map(
      (c) => `<tr class="${c.ok ? '' : 'fail'}"><td class="ms">${(c.ms / 1000).toFixed(2)}s</td>
      <td class="track">${bar(c.ms, maxCase)}</td><td>${esc(c.name)}</td><td class="file">${esc(c.file)}</td></tr>`,
    )
    .join('\n');
  return `<!doctype html><meta charset="utf-8"><title>test timing</title>
<style>
  body{font:13px/1.4 -apple-system,system-ui,sans-serif;margin:24px;color:#1a1a1a}
  h1{font-size:18px}h2{font-size:15px;margin-top:28px}
  .sum{color:#666;margin:4px 0 16px}
  table{border-collapse:collapse;width:100%;max-width:1100px}
  td{padding:3px 8px;border-bottom:1px solid #eee;vertical-align:middle}
  .ms{font-variant-numeric:tabular-nums;text-align:right;white-space:nowrap;font-weight:600;width:64px}
  .track{width:180px}.bar{height:11px;background:#4a90d9;border-radius:2px;min-width:1px}
  tr.fail .bar{background:#d0021b}.x{color:#d0021b;font-weight:600}
  .n{text-align:right;color:#666;width:70px}.file{color:#999;font-size:11px}
  td:nth-child(3){font-family:ui-monospace,monospace;font-size:12px}
</style>
<h1>Test timing</h1>
<div class="sum">Σ file wall-time <b>${(totalMs / 1000).toFixed(1)}s</b> · ${files.length} files (node:test runs files concurrently, so real wall-clock &lt; Σ). Target the top files.</div>
<h2>Slowest files</h2>
<table>${fileRows}</table>
<h2>Slowest test cases (top ${cases.length})</h2>
<table>${caseRows}</table>`;
}
