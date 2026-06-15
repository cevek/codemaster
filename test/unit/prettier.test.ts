// Stage B oracle for support/prettier/. The rule under test (spec: a repo that doesn't ship
// prettier, or ships no prettier config, is NOT reformatted): there is NO bundled fallback,
// so a temp project with no prettier resolves `available: false`; with the project's own
// prettier symlinked in it resolves `available: true`. formatContent oracles: a hand-written
// expected formatting that honours a fixture `.prettierrc` (config resolution, not just "it
// ran"); an `ok(null)` skip when there's no config; an `ok(null)` skip for an extension
// prettier won't parse; and a broken config recorded as a `ToolFailure`, never a throw.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, symlinkSync } from 'node:fs';
import { createRequire } from 'node:module';
import * as os from 'node:os';
import * as path from 'node:path';
import { resolvePrettier } from '../../src/support/prettier/resolve.ts';
import { formatContent } from '../../src/support/prettier/format.ts';

const require = createRequire(import.meta.url);
/** codemaster's own prettier install — symlinked into a temp project so `createRequire`
 *  rooted at that project resolves a real `node_modules/prettier`. */
const prettierDir = path.dirname(require.resolve('prettier/package.json'));

function tempProject(files: Record<string, string>, opts?: { withPrettier?: boolean }): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'cm-prettier-'));
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, content, 'utf8');
  }
  if (opts?.withPrettier === true) {
    mkdirSync(path.join(dir, 'node_modules'), { recursive: true });
    symlinkSync(prettierDir, path.join(dir, 'node_modules', 'prettier'), 'dir');
  }
  return dir;
}

test('resolvePrettier reports unavailable when the project ships no prettier (no bundled fallback)', async () => {
  const dir = tempProject({ 'package.json': '{}' });
  try {
    const resolved = await resolvePrettier(dir);
    assert.equal(resolved.available, false);
    if (!resolved.available) assert.match(resolved.reason, /does not ship prettier/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resolvePrettier resolves the project's own prettier", async () => {
  const dir = tempProject({ 'package.json': '{}' }, { withPrettier: true });
  try {
    const resolved = await resolvePrettier(dir);
    assert.ok(resolved.available); // only the project copy can satisfy this now
    if (resolved.available) assert.match(resolved.version, /^\d+\./);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('formatContent honours the project .prettierrc (config resolution, not just a run)', async () => {
  const dir = tempProject(
    {
      'package.json': '{}',
      '.prettierrc.json': '{ "singleQuote": true, "semi": false }',
      'src/x.ts': 'const x = "a"\n',
    },
    { withPrettier: true },
  );
  try {
    const resolved = await resolvePrettier(dir);
    assert.ok(resolved.available);
    if (!resolved.available) return;
    const out = await formatContent(resolved.api, path.join(dir, 'src/x.ts'), 'const   x = "a"\n');
    assert.ok(out.ok);
    // Oracle: single quotes + no semicolons, per the fixture config — hand-written.
    if (out.ok) assert.equal(out.data, "const x = 'a'\n");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('formatContent skips a file when the project has no prettier config (ok(null))', async () => {
  // prettier is installed but there is NO config — the rule: do not impose prettier defaults.
  const dir = tempProject(
    { 'package.json': '{}', 'src/x.ts': 'const   x = "a"\n' },
    {
      withPrettier: true,
    },
  );
  try {
    const resolved = await resolvePrettier(dir);
    assert.ok(resolved.available);
    if (!resolved.available) return;
    const out = await formatContent(resolved.api, path.join(dir, 'src/x.ts'), 'const   x = "a"\n');
    assert.ok(out.ok);
    if (out.ok) assert.equal(out.data, null); // no config → honest skip, not a defaults reformat
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('formatContent skips when only a .prettierignore is present, no config (intended: config required)', async () => {
  // A `.prettierignore` is NOT a prettier config — `resolveConfig` returns null — so the rule
  // ("no config → do not run prettier") skips. Locks the deliberate decision so it can't silently
  // regress to formatting-with-defaults.
  const dir = tempProject(
    { 'package.json': '{}', '.prettierignore': 'dist/\n', 'src/x.ts': 'const   x = "a"\n' },
    { withPrettier: true },
  );
  try {
    const resolved = await resolvePrettier(dir);
    assert.ok(resolved.available);
    if (!resolved.available) return;
    const out = await formatContent(resolved.api, path.join(dir, 'src/x.ts'), 'const   x = "a"\n');
    assert.ok(out.ok);
    if (out.ok) assert.equal(out.data, null); // ignore-file present but no config → still skipped
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('formatContent skips a file prettier cannot parse (ok(null), not a failure)', async () => {
  const dir = tempProject(
    { 'package.json': '{}', 'notes.txt': 'plain text\n' },
    {
      withPrettier: true,
    },
  );
  try {
    const resolved = await resolvePrettier(dir);
    assert.ok(resolved.available);
    if (!resolved.available) return;
    const out = await formatContent(resolved.api, path.join(dir, 'notes.txt'), 'raw   text');
    assert.ok(out.ok);
    if (out.ok) assert.equal(out.data, null); // no inferred parser → honest skip
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('formatContent records a broken .prettierrc as a ToolFailure, never throws', async () => {
  const dir = tempProject(
    {
      'package.json': '{}',
      '.prettierrc.json': '{ this is not valid json',
      'src/x.ts': 'const x = 1\n',
    },
    { withPrettier: true },
  );
  try {
    const resolved = await resolvePrettier(dir);
    assert.ok(resolved.available);
    if (!resolved.available) return;
    const out = await formatContent(resolved.api, path.join(dir, 'src/x.ts'), 'const x = 1\n');
    assert.equal(out.ok, false);
    if (!out.ok) assert.equal(out.failure.tool, 'prettier');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
