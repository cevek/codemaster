// Real-process proof that a permanently-wedged daemon is RECOVERED, not merely reported (t-000051).
// A unit test with a fake clock can't catch this: the wedge is a real frozen OS process, the kill is
// a real signal, and the respawn is a real detached spawn/bind. We simulate the true
// "accepts-connections-but-never-replies" wedge with SIGSTOP — the kernel still completes a client
// connect() into the listen backlog, but the frozen process never accepts/replies AND never
// idle-exits (its own loop is stopped) — exactly the case that is otherwise unreapable. `daemon
// restart` must pidfile-target it, SIGKILL it (SIGTERM can't be serviced by a stopped process), and
// bind a fresh daemon. Proof is the LIFECYCLE fact (old pid actually gone + a fresh pid answers),
// not the flush-racy restart stdout.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isProcessAlive } from '../../src/support/pidfile/liveness.ts';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const BIN = path.join(repoRoot, 'src', 'bin.ts');

function cleanEnv(extra: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
  return { ...env, ...extra };
}

interface VerbResult {
  code: number;
  out: string;
  err: string;
}

function runVerb(verb: string, env: Record<string, string>): Promise<VerbResult> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [BIN, 'daemon', verb], {
      cwd: repoRoot,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (d: Buffer) => (out += d.toString()));
    child.stderr.on('data', (d: Buffer) => (err += d.toString()));
    child.on('close', (code) => resolve({ code: code ?? -1, out, err }));
  });
}

const diag = (r: VerbResult): string =>
  r.err.length > 0 ? `${r.out}\n--- stderr ---\n${r.err}` : r.out;

async function waitFor(cond: () => boolean, budgetMs: number): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < budgetMs) {
    if (cond()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return cond();
}

const socketGone = (dir: string): boolean => !existsSync(dir) || readdirSync(dir).length === 0;

/** Locate the daemon's pidfile (`<socket>.sock.pid`) in the isolated socket dir. */
function findPidfile(sockDir: string): string | undefined {
  const hit = readdirSync(sockDir).find((f) => f.endsWith('.sock.pid'));
  return hit === undefined ? undefined : path.join(sockDir, hit);
}

async function statusPid(env: Record<string, string>): Promise<number | undefined> {
  const s = await runVerb('status', env);
  const m = /pid=(\d+)/.exec(s.out);
  return m === null ? undefined : Number(m[1]);
}

test('wedged daemon (SIGSTOP): `daemon restart` force-kills the frozen daemon and binds a fresh one', async () => {
  const sockDir = mkdtempSync(path.join(tmpdir(), 'cm-wedge-'));
  const env = cleanEnv({ CODEMASTER_SOCK_DIR: sockDir, CODEMASTER_MCP_IDLE_MS: '30000' });
  let oldPid: number | undefined;
  try {
    const start = await runVerb('start', env);
    assert.equal(start.code, 0, diag(start));
    oldPid = Number(/pid=(\d+)/.exec(start.out)?.[1]);
    assert.ok(oldPid > 0, `started with a pid: ${diag(start)}`);

    // A1: the daemon dropped a kill-target-hint pidfile naming itself.
    const pidfile = findPidfile(sockDir);
    assert.ok(pidfile !== undefined, 'daemon dropped a pidfile at bind');
    const rec = JSON.parse(readFileSync(pidfile, 'utf8')) as { pid: number; socket: string };
    assert.equal(rec.pid, oldPid, 'pidfile names the running daemon');

    // Freeze it: connections still queue at the kernel, but the process never replies and never
    // idle-exits — the unreapable wedge.
    process.kill(oldPid, 'SIGSTOP');

    // A2: restart must reap the frozen daemon (pidfile-targeted) and bind a fresh one. This blocks
    // through the graceful shutdown deadline (unanswered → wedged) before escalating.
    const restart = await runVerb('restart', env);
    assert.equal(restart.code, 0, diag(restart));

    // Proof 1 — the frozen process is actually GONE (force-killed, not idle-exited: it couldn't
    // idle-exit while stopped). This is what distinguishes recovery from mere honest reporting.
    const gone = await waitFor(() => oldPid !== undefined && !isProcessAlive(oldPid), 6000);
    assert.ok(gone, 'the wedged daemon was force-killed');

    // Proof 2 — a fresh daemon answers status with a different pid.
    const freshPid = await (async (): Promise<number | undefined> => {
      const start2 = Date.now();
      for (;;) {
        const pid = await statusPid(env);
        if (pid !== undefined && pid !== oldPid) return pid;
        if (Date.now() - start2 >= 8000) return pid;
        await new Promise((r) => setTimeout(r, 50));
      }
    })();
    assert.ok(
      freshPid !== undefined && freshPid !== oldPid,
      `restart bound a fresh daemon (was ${oldPid}, now ${freshPid})`,
    );
  } finally {
    // A stopped process won't reap on its own — continue then kill it if the test bailed early.
    if (oldPid !== undefined && isProcessAlive(oldPid)) {
      try {
        process.kill(oldPid, 'SIGCONT');
      } catch {
        /* already gone */
      }
      try {
        process.kill(oldPid, 'SIGKILL');
      } catch {
        /* already gone */
      }
    }
    await runVerb('stop', env).catch(() => undefined);
    await waitFor(() => socketGone(sockDir), 5000);
    rmSync(sockDir, { recursive: true, force: true });
  }
});
