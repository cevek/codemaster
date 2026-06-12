// spec-status-as-the-doc §4: the parallel `docs/agent-guide.md` is retired — `status` IS
// the documentation. A removed doc that something still points to is a broken-link lie, so
// assert it's gone AND that no LIVING surface (source + the present-state top-level docs)
// references it. Historical design specs under docs/spec-*.md may name it as past work —
// they are point-in-time records, like git history, and are out of scope.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

test('docs/agent-guide.md is deleted', () => {
  assert.ok(!existsSync(path.join(REPO, 'docs/agent-guide.md')), 'the parallel guide must be gone');
});

test('no living surface references agent-guide.md (broken-link lie)', () => {
  // git grep over tracked files, then exclude this test and the historical design specs.
  let hits: string[] = [];
  try {
    const out = execFileSync('git', ['grep', '-l', 'agent-guide', '--', '.'], {
      cwd: REPO,
      encoding: 'utf8',
    });
    hits = out.split('\n').filter(Boolean);
  } catch {
    hits = []; // git grep exits non-zero when there are no matches
  }
  const living = hits.filter(
    (f) => !f.startsWith('docs/spec-') && f !== 'test/unit/no-agent-guide.test.ts',
  );
  assert.deepEqual(living, [], `living references to agent-guide.md remain: ${living.join(', ')}`);
});
