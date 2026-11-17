// `execFile` throws SYNCHRONOUSLY for some failures (an invalid argument here; `EBADF` on macOS
// past ~10240 open descriptors, t-142288). The real runGit must resolve that to a git failure, not
// reject.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runGit } from '../../src/support/git/run.ts';

test('a synchronous spawn throw resolves to a git ToolFailure', async () => {
  const result = await runGit(process.cwd(), ['status', 'nul\0byte']);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.failure.tool, 'git');
  assert.match(result.failure.message, /^git status /);
});
