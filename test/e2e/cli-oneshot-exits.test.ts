// spec-daemon-singleton §5 + Stage 1: the CLI one-shot path (`status`/`op`) must stay one-shot —
// it builds an in-process orchestrator, answers, and exits, reflecting the CURRENT source with no
// daemon to reconnect. The idle self-exit timer is wired ONLY in serveMcp's `mcp` path; the CLI
// commands never call serveMcp, so no idle timer can leak into them. The oracle is a real
// subprocess: `node src/bin.ts status` must EXIT on its own within a bounded time — if a timer
// (or any handle) kept the one-shot alive, execFileSync would hit its timeout and throw.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { project } from '../helpers/project.ts';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const BIN = path.join(repoRoot, 'src', 'bin.ts');

test('CLI `status` one-shot exits on its own (no leaked idle timer)', async () => {
  const p = await project({
    'tsconfig.json': '{"compilerOptions":{"strict":true}}',
    'src/index.ts': 'export const x = 1;\n',
  });
  try {
    // A hung process would blow this timeout; returning at all proves the one-shot terminated.
    const out = execFileSync('node', [BIN, 'status', '--root', p.root], {
      cwd: repoRoot,
      encoding: 'utf8',
      timeout: 60_000,
    });
    assert.match(out, /codemaster/i, 'status rendered a manifest');
  } finally {
    await p.dispose();
  }
});
