// The headline real-process smoke for the daemon management verbs (spec-daemon-cli §5). Drives the
// REAL CLI — `node bin.ts daemon <verb>` as subprocesses against one shared socket dir — through the
// full lifecycle: status(none) → start → status(running) → stop → status(none) → restart →
// status(running) → restart-WHILE-LIVE → status(fresh pid). The restart-while-live step proves the
// headline "pick up new code" use case: the old process is killed and a fresh one binds (new pid).
// This is the live oracle that the dispatch split (`daemon serve` vs the verbs),
// the detached spawn, the daemon-info probe, and the control-message shutdown actually work
// end-to-end over a real unix socket. The deterministic no-hang / error-mapping paths are unit-tested
// in daemon-manage.test.ts (this smoke only exercises a healthy daemon).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

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

/** Run one `daemon <verb>` as a real subprocess; resolve its stdout + STDERR + exit code. stderr is
 *  piped (not discarded) purely for diagnostics — a failed assertion on a real subprocess is opaque
 *  without it (the `1 !== 0` tells you nothing about WHY the verb failed). It is never asserted on. */
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

/** Assertion message: the verb's stdout, plus its stderr when non-empty (the diagnostic the opaque
 *  exit-code mismatch otherwise hides). */
const diag = (r: VerbResult): string =>
  r.err.length > 0 ? `${r.out}\n--- stderr ---\n${r.err}` : r.out;

/** Bounded poll for the LIFECYCLE fact that a restart bound a FRESH daemon: re-query `status` until it
 *  reports a pid different from `oldPid` (or the budget runs out). Load-independent — it reads the
 *  daemon's actual identity, not the restart verb's own (flush-racy) stdout. Returns the observed pid. */
async function waitForFreshPid(
  env: Record<string, string>,
  oldPid: string | undefined,
  budgetMs: number,
): Promise<string | undefined> {
  const start = Date.now();
  for (;;) {
    const s = await runVerb('status', env);
    const pid = /pid=(\d+)/.exec(s.out)?.[1];
    if (pid !== undefined && pid !== oldPid) return pid;
    if (Date.now() - start >= budgetMs) return pid;
    await new Promise((r) => setTimeout(r, 50));
  }
}

async function waitFor(cond: () => boolean, budgetMs: number): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < budgetMs) {
    if (cond()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return cond();
}

const socketGone = (dir: string): boolean => !existsSync(dir) || readdirSync(dir).length === 0;

test('daemon CLI: status → start → status → stop → status → restart over a real socket', async () => {
  const sockDir = mkdtempSync(path.join(tmpdir(), 'cm-cli-'));
  // A generous idle TTL so the daemon survives between the sequential one-shot verbs; the final
  // `stop` reaps it, so nothing lingers (the TTL is only the backstop if a step fails).
  const env = cleanEnv({ CODEMASTER_SOCK_DIR: sockDir, CODEMASTER_MCP_IDLE_MS: '20000' });
  try {
    const none = await runVerb('status', env);
    assert.equal(none.code, 0, diag(none));
    assert.match(none.out, /no daemon running/, 'a fresh socket dir → honest none');

    const start = await runVerb('start', env);
    assert.equal(start.code, 0, diag(start));
    assert.match(start.out, /daemon started \(pid=\d+\)/, 'start spawns + reports the pid');
    const startedPid = /pid=(\d+)/.exec(start.out)?.[1];

    const up = await runVerb('status', env);
    assert.equal(up.code, 0, diag(up));
    assert.match(up.out, /daemon running pid=\d+ uptime=\S+ engines=\d+/, 'status sees it running');
    assert.equal(/pid=(\d+)/.exec(up.out)?.[1], startedPid, 'same daemon pid as start reported');

    const stop = await runVerb('stop', env);
    assert.equal(stop.code, 0, diag(stop));
    assert.match(stop.out, /daemon stopped \(socket released/, 'stop is graceful');

    const downAgain = await waitFor(() => socketGone(sockDir), 5000);
    assert.ok(downAgain, 'stop unlinked the socket');
    const none2 = await runVerb('status', env);
    assert.equal(none2.code, 0, diag(none2));
    assert.match(none2.out, /no daemon running/, 'after stop → honest none');

    const restart = await runVerb('restart', env);
    assert.equal(restart.code, 0, diag(restart));
    assert.match(restart.out, /daemon started \(pid=\d+\)/, 'restart-from-none starts a fresh one');
    assert.match(restart.out, /must reconnect/, 'restart warns clients to reconnect');

    const up2 = await runVerb('status', env);
    assert.match(up2.out, /daemon running pid=\d+/, 'the restarted daemon answers');
    const livePid = /pid=(\d+)/.exec(up2.out)?.[1];

    // The headline use case: restart WHILE a daemon is live must kill it and bind a FRESH one — a
    // different pid is the proof the old process actually died and the socket was rebound (this is
    // "pick up new code"). Restart-from-none above can't prove that; this can.
    //
    // We assert the LIFECYCLE fact (the pid changed), NOT the restart verb's own stdout: a restart
    // verb's stdout flush races under CI load (it can resolve code 0 with truncated output), so a
    // `/daemon stopped…started/` match on it is the flake. The pid-change is load-independent. The
    // "stopped then started" WORDING is pinned deterministically in test/unit/daemon-manage.test.ts.
    const restart2 = await runVerb('restart', env);
    assert.equal(restart2.code, 0, diag(restart2));
    const freshPid = await waitForFreshPid(env, livePid, 5000);
    assert.ok(
      freshPid !== undefined && freshPid !== livePid,
      `restart bound a fresh daemon (was ${livePid}, now ${freshPid})`,
    );
  } finally {
    await runVerb('stop', env).catch(() => undefined);
    await waitFor(() => socketGone(sockDir), 5000);
    rmSync(sockDir, { recursive: true, force: true });
  }
});

// Real-spawn convergence (the socket-path env-independence fix, §2): two subprocesses with the SAME
// base dir but DIFFERENT TMPDIR must meet on ONE socket — i.e. the base wins, TMPDIR never factors
// into the path end-to-end. The deterministic env-independence of the *default* (no seam) is pinned
// by the unit test; this is the live spawn/bind/find/stop proof on an isolated path that never
// touches the user's real ~/.codemaster/run (the seam keeps it isolated). A daemon `start` under one
// TMPDIR, then `status` under another, must report the SAME running pid.
test('daemon CLI: a differing TMPDIR does not split the socket — start/status converge', async () => {
  const sockDir = mkdtempSync(path.join(tmpdir(), 'cm-conv-'));
  const base = { CODEMASTER_SOCK_DIR: sockDir, CODEMASTER_MCP_IDLE_MS: '20000' };
  const envStart = cleanEnv({ ...base, TMPDIR: '/tmp' });
  const envQuery = cleanEnv({ ...base, TMPDIR: '/var/folders/zz/codemaster-divergent/T' });
  try {
    const start = await runVerb('start', envStart);
    assert.equal(start.code, 0, diag(start));
    assert.match(start.out, /daemon started \(pid=\d+\)/, 'start under TMPDIR=/tmp');
    const startedPid = /pid=(\d+)/.exec(start.out)?.[1];

    const seen = await runVerb('status', envQuery);
    assert.equal(seen.code, 0, diag(seen));
    assert.match(seen.out, /daemon running pid=\d+/, 'a different TMPDIR still finds the daemon');
    assert.equal(
      /pid=(\d+)/.exec(seen.out)?.[1],
      startedPid,
      'same socket → same pid, despite the divergent TMPDIR',
    );
  } finally {
    await runVerb('stop', envStart).catch(() => undefined);
    await waitFor(() => socketGone(sockDir), 5000);
    rmSync(sockDir, { recursive: true, force: true });
  }
});
