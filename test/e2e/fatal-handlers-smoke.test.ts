// Real-process repro of incident t-216182, defect 1: an `mcp --in-process` server whose host's
// stdout/stderr pipes die (host gone, stdin peer still OPEN — so no EOF path) used to enter an
// uncaughtException EPIPE storm at ~100% CPU forever. The fix must EXIT instead, leaving a
// `host-gone` stall record. The oracle is the OS: the child's observed exit + the record on disk.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'bin.ts');

test('mcp --in-process with dead stdout/stderr peers EXITS with a host-gone stall record (no EPIPE storm)', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'cm-epipe-'));
  const stallDir = path.join(dir, 'stalls');
  writeFileSync(path.join(dir, 'tsconfig.json'), '{"compilerOptions":{"strict":true}}');
  writeFileSync(path.join(dir, 'x.ts'), 'export const x = 1;\n');
  const child = spawn(process.execPath, [BIN, 'mcp', '--in-process'], {
    cwd: dir,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      CODEMASTER_STALL_DIR: stallDir,
      // Idle-exit must not fake a pass — the exit under test is the host-gone one.
      CODEMASTER_MCP_IDLE_MS: '600000',
      CODEMASTER_USAGE_LOG: '0',
    },
  });
  try {
    // Complete the MCP handshake so the server is fully up before the peers die.
    child.stdin.write(
      `${JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'epipe-repro', version: '0' },
        },
      })}\n`,
    );
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('no initialize reply')), 20_000);
      timer.unref();
      child.stdout.once('data', () => {
        clearTimeout(timer);
        resolve();
      });
      child.on('error', reject);
    });
    child.stdin.write(
      `${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`,
    );

    // The repro's load-bearing shape: stdout AND stderr peers die, stdin stays OPEN (no EOF path).
    child.stdout.destroy();
    child.stderr.destroy();
    // The reply write to the dead stdout is what hits EPIPE.
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' })}\n`);

    const outcome = await new Promise<{ code: number | null; signal: string | null }>(
      (resolve, reject) => {
        const timer = setTimeout(() => {
          child.kill('SIGKILL');
          reject(new Error('server did NOT exit — the EPIPE storm is back (t-216182)'));
        }, 20_000);
        timer.unref();
        child.on('exit', (code, signal) => {
          clearTimeout(timer);
          resolve({ code, signal });
        });
      },
    );
    assert.equal(outcome.code, 1, `expected a deliberate exit(1), got ${JSON.stringify(outcome)}`);
    const stalls = readdirSync(stallDir).filter((f) => f.endsWith('.json'));
    assert.ok(stalls.length >= 1, 'a stall record names why the process exited');
    const record = JSON.parse(readFileSync(path.join(stallDir, stalls[0] ?? ''), 'utf8')) as {
      reason: string;
      op: string;
    };
    assert.equal(record.reason, 'host-gone');
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    rmSync(dir, { recursive: true, force: true });
  }
});
