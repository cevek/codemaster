// Gate 1 (spec docs/spec-synthetic-fixture.md §6, "the strong gate"): the kitchensink
// fixture must typecheck clean under its OWN tsconfig. tsconfig.test.json excludes it (it
// can't compile under the project's NodeNext / erasableSyntaxOnly settings), so without this
// nothing guards a mis-built fixture from regressing. Independent oracle: a cold
// `tsc --noEmit`, not codemaster's own LanguageService.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const FIXTURE_TSCONFIG = path.join(
  REPO_ROOT,
  'test',
  'fixtures',
  'repos',
  'kitchensink',
  'tsconfig.json',
);

test('gate 1 — fixture typechecks clean under its own tsconfig (cold tsc --noEmit)', () => {
  const tsc = path.join(REPO_ROOT, 'node_modules', '.bin', 'tsc');
  try {
    execFileSync(tsc, ['--noEmit', '-p', FIXTURE_TSCONFIG], {
      encoding: 'utf8',
      stdio: 'pipe',
      timeout: 120_000,
    });
  } catch (thrown) {
    const out = thrown as { stdout?: string; stderr?: string };
    assert.fail(`fixture tsc must be clean:\n${out.stdout ?? ''}${out.stderr ?? ''}`);
  }
});
