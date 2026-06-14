// Stage B oracle for support/prettier/. Oracles: a hand-written expected formatting that
// honours a fixture `.prettierrc` (proves config resolution, not just "prettier ran"); the
// skip contract (`ok(null)`) for an extension prettier won't parse; and a broken config
// recorded as a `ToolFailure`, never a throw. No project-local prettier exists in a temp
// dir, so the resolver must fall to the bundled copy and say so (§5-L1 "report which").

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { resolvePrettier } from '../../src/support/prettier/resolve.ts';
import { formatContent } from '../../src/support/prettier/format.ts';

function tempProject(files: Record<string, string>): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'cm-prettier-'));
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, content, 'utf8');
  }
  return dir;
}

test('resolvePrettier falls back to the bundled copy and reports it', async () => {
  const dir = tempProject({ 'package.json': '{}' });
  try {
    const resolved = await resolvePrettier(dir);
    assert.ok(resolved.available);
    if (resolved.available) {
      assert.equal(resolved.source, 'bundled'); // no prettier in the temp project
      assert.match(resolved.version, /^\d+\./);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('formatContent honours the project .prettierrc (config resolution, not just a run)', async () => {
  const dir = tempProject({
    'package.json': '{}',
    '.prettierrc.json': '{ "singleQuote": true, "semi": false }',
    'src/x.ts': 'const x = "a"\n',
  });
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

test('formatContent skips a file prettier cannot parse (ok(null), not a failure)', async () => {
  const dir = tempProject({ 'package.json': '{}', 'notes.txt': 'plain text\n' });
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
  const dir = tempProject({
    'package.json': '{}',
    '.prettierrc.json': '{ this is not valid json',
    'src/x.ts': 'const x = 1\n',
  });
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
