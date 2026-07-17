// Watchdog real-process smoke (t-095661). The unit tests prove the beacon codec / predicate /
// orphan poll deterministically; these prove the two things only a real spawn can — a worker thread
// reaping a genuinely WEDGED main loop (backstop 1), and a real ORPHANED child self-exiting when its
// parent dies (backstop 2). Both are timing-based against a real OS, so thresholds are tiny and the
// outer timeouts generous.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, existsSync, rmSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const HARNESS = path.join(path.dirname(fileURLToPath(import.meta.url)), 'watchdog-harness.ts');

test('backstop 1: the worker reaps a WEDGED main loop — stall record + SIGKILL', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'cm-wd-wedge-'));
  try {
    const child = spawn(process.execPath, [HARNESS, 'wedge'], {
      stdio: ['ignore', 'ignore', 'pipe'],
      env: {
        ...process.env,
        CODEMASTER_WATCHDOG_MS: '200', // wedge threshold — tiny for the test
        CODEMASTER_WATCHDOG_POLL_MS: '50',
        CODEMASTER_STALL_DIR: dir,
      },
    });
    let stderr = '';
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (c: string) => (stderr += c));

    const signal = await new Promise<string | null>((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(
          new Error(`wedged process was NOT reaped in time (watchdog dead?). stderr:\n${stderr}`),
        );
      }, 15_000);
      timer.unref();
      child.on('exit', (_code, sig) => {
        clearTimeout(timer);
        resolve(sig);
      });
      child.on('error', reject);
    });

    assert.equal(signal, 'SIGKILL', `expected SIGKILL from the watchdog, got signal ${signal}`);
    const stalls = readdirSync(dir).filter((f) => f.endsWith('.json'));
    assert.ok(stalls.length >= 1, 'the worker wrote a stall breadcrumb before killing');
    const record = JSON.parse(readFileSync(path.join(dir, stalls[0] ?? ''), 'utf8')) as {
      reason: string;
      op: string;
    };
    assert.equal(record.reason, 'wedge');
    assert.match(record.op, /op:wedge-test/, 'the breadcrumb names WHAT was running');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('backstop 2: an ORPHANED in-process child is reaped (not lingering) when its parent dies', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'cm-wd-orphan-'));
  const marker = path.join(dir, 'orphaned.marker');
  const pidFile = path.join(dir, 'child.pid');
  try {
    const parent = spawn(process.execPath, [HARNESS, 'orphan-parent'], {
      stdio: ['ignore', 'ignore', 'pipe'],
      env: {
        ...process.env,
        CODEMASTER_TEST_MARKER: marker,
        CODEMASTER_TEST_CHILD_PID_FILE: pidFile,
        CODEMASTER_WATCHDOG_POLL_MS: '50', // orphan poll cadence
        CODEMASTER_WATCHDOG_MS: '600000', // keep the wedge threshold out of the way
      },
    });
    // The parent exits on its own (~200ms) after spawning the detached child; wait for that.
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('orphan-parent never exited')), 15_000);
      timer.unref();
      parent.on('exit', () => {
        clearTimeout(timer);
        resolve();
      });
      parent.on('error', reject);
    });

    const childPid = Number(readFileSync(pidFile, 'utf8'));
    assert.ok(
      Number.isInteger(childPid) && childPid > 0,
      'harness recorded the orphaned child pid',
    );
    // PRIMARY invariant (the incident itself): the orphan does NOT linger — it is reaped, regardless
    // of which backstop (graceful main-loop poll vs worker) wins. Robust to CI scheduling jitter.
    await waitFor(() => !alive(childPid), 15_000);
    assert.equal(alive(childPid), false, 'the orphaned child was reaped, not left spinning');
    // SECONDARY: on the expected path the graceful main-loop poll wins and writes the marker.
    assert.ok(existsSync(marker), 'the child shut down via the graceful orphan path');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** Process-existence check (kill(pid,0)): ESRCH ⇒ gone, EPERM ⇒ alive-but-not-ours. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (thrown) {
    return (thrown as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Poll a predicate until true or the deadline — used to await a real subprocess's side effect. */
async function waitFor(pred: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
}
