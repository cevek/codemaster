// t-310874 + the bare-dir sub-bug: the path-filter glob layer must (a) expand a bare dir to
// exact-or-under, (b) match a LITERAL directory whose name contains glob-special chars
// (`src/(auth)`, `src/@scope`, `src/a+b` — Next.js route groups / scoped dirs), and (c) pass a
// genuine wildcard pattern through verbatim. Oracle: picomatch's own match on the produced globs
// — a produced glob set that does NOT match the real path is the exact "no working incantation" bug.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { expandDirGlobs, escapeGlobLiteral } from '../../src/common/glob/expand-dir.ts';
import { matchesPathFilter } from '../../src/common/glob/path-filter.ts';

test('a bare dir expands to exact-or-under (`X` → matches X/**)', () => {
  assert.equal(matchesPathFilter('src/daemon/host.ts', ['src/daemon']), true);
  assert.equal(matchesPathFilter('src/daemon', ['src/daemon']), true); // the dir path itself
  assert.equal(matchesPathFilter('src/other/x.ts', ['src/daemon']), false);
});

test('a literal dir with glob-special chars matches (t-310874 — was picomatch-mis-parsed)', () => {
  for (const [dir, hit, miss] of [
    ['src/(auth)', 'src/(auth)/page.tsx', 'src/(admin)/page.tsx'],
    ['src/@scope', 'src/@scope/x.ts', 'src/scope/x.ts'],
    ['src/a+b', 'src/a+b/y.ts', 'src/ab/y.ts'],
    ['src/c!d', 'src/c!d/z.ts', 'src/cd/z.ts'],
  ] as const) {
    assert.equal(matchesPathFilter(hit, [dir]), true, `${dir} must match ${hit}`);
    assert.equal(matchesPathFilter(miss, [dir]), false, `${dir} must NOT match ${miss}`);
  }
});

test('an exact wildcard-less FILE path still matches itself', () => {
  assert.equal(matchesPathFilter('src/a.ts', ['src/a.ts']), true);
  assert.equal(matchesPathFilter('src/a.ts', ['src/b.ts']), false);
});

test('a genuine wildcard pattern passes through verbatim (not escaped, not dir-expanded)', () => {
  assert.deepEqual(expandDirGlobs(['**/*.test.*']), ['**/*.test.*']);
  assert.equal(matchesPathFilter('src/x.test.ts', ['**/*.test.*']), true);
  assert.equal(matchesPathFilter('src/x.ts', ['**/*.test.*']), false);
  // a wildcard entry is NOT dir-expanded, so it never gains a spurious `/**` twin
  assert.deepEqual(expandDirGlobs(['src/**/ui']), ['src/**/ui']);
});

test('escapeGlobLiteral neutralizes picomatch metachars but keeps path separators', () => {
  assert.equal(escapeGlobLiteral('src/(auth)'), 'src/\\(auth\\)');
  assert.ok(!escapeGlobLiteral('a/b/c').includes('\\'), 'plain path unchanged');
});
