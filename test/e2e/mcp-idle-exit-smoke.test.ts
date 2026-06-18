// spec-daemon-singleton §7 (the one REAL smoke) + Stage 1 headline oracle: a live `mcp` server
// whose stdin stays open-but-silent (EOF never arrives — the exact orphan condition) must still
// self-exit after the idle TTL. This is what the unit tests CAN'T prove: the production timer is
// `unref`ed, yet the open stdin keeps the event loop alive, so the timer genuinely fires and the
// process exits on its own. We drive a real `node src/bin.ts mcp` subprocess with a sub-second TTL
// (the `CODEMASTER_MCP_IDLE_MS` test override — production uses whole minutes via config), hold its
// stdin open, and assert exit(0) within a bounded time. A hang here = the orphan bug is back.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const BIN = path.join(repoRoot, 'src', 'bin.ts');

test('live `mcp` server self-exits after the idle TTL with stdin held open (no EOF)', async () => {
  const child = spawn('node', [BIN, 'mcp'], {
    cwd: repoRoot,
    // 400ms idle TTL — fast + deterministic; stdin is piped and never ended, so EOF never arrives.
    env: { ...process.env, CODEMASTER_MCP_IDLE_MS: '400' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => (stderr += chunk));

  const code = await new Promise<number | null>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(
        new Error(`mcp server did not self-exit within timeout (orphan bug?). stderr:\n${stderr}`),
      );
    }, 20_000);
    timer.unref();
    child.on('exit', (exitCode) => {
      clearTimeout(timer);
      resolve(exitCode);
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });

  assert.equal(code, 0, `expected clean idle self-exit (0), got ${code}. stderr:\n${stderr}`);
});
