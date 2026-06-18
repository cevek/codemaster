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

/** Run one `daemon <verb>` as a real subprocess; resolve its stdout + exit code. */
function runVerb(
  verb: string,
  env: Record<string, string>,
): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [BIN, 'daemon', verb], {
      cwd: repoRoot,
      env,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    let out = '';
    child.stdout.on('data', (d: Buffer) => (out += d.toString()));
    child.on('close', (code) => resolve({ code: code ?? -1, out }));
  });
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
    assert.equal(none.code, 0, none.out);
    assert.match(none.out, /no daemon running/, 'a fresh socket dir → honest none');

    const start = await runVerb('start', env);
    assert.equal(start.code, 0, start.out);
    assert.match(start.out, /daemon started \(pid=\d+\)/, 'start spawns + reports the pid');
    const startedPid = /pid=(\d+)/.exec(start.out)?.[1];

    const up = await runVerb('status', env);
    assert.equal(up.code, 0, up.out);
    assert.match(up.out, /daemon running pid=\d+ uptime=\S+ engines=\d+/, 'status sees it running');
    assert.equal(/pid=(\d+)/.exec(up.out)?.[1], startedPid, 'same daemon pid as start reported');

    const stop = await runVerb('stop', env);
    assert.equal(stop.code, 0, stop.out);
    assert.match(stop.out, /daemon stopped \(socket released/, 'stop is graceful');

    const downAgain = await waitFor(() => socketGone(sockDir), 5000);
    assert.ok(downAgain, 'stop unlinked the socket');
    const none2 = await runVerb('status', env);
    assert.equal(none2.code, 0, none2.out);
    assert.match(none2.out, /no daemon running/, 'after stop → honest none');

    const restart = await runVerb('restart', env);
    assert.equal(restart.code, 0, restart.out);
    assert.match(restart.out, /daemon started \(pid=\d+\)/, 'restart-from-none starts a fresh one');
    assert.match(restart.out, /must reconnect/, 'restart warns clients to reconnect');

    const up2 = await runVerb('status', env);
    assert.match(up2.out, /daemon running pid=\d+/, 'the restarted daemon answers');
    const livePid = /pid=(\d+)/.exec(up2.out)?.[1];

    // The headline use case: restart WHILE a daemon is live must kill it and bind a FRESH one — a
    // different pid is the proof the old process actually died and the socket was rebound (this is
    // "pick up new code"). Restart-from-none above can't prove that; this can.
    const restart2 = await runVerb('restart', env);
    assert.equal(restart2.code, 0, restart2.out);
    assert.match(
      restart2.out,
      /daemon stopped[\s\S]*daemon started/,
      'restart-while-live = stop then start',
    );
    const up3 = await runVerb('status', env);
    const freshPid = /pid=(\d+)/.exec(up3.out)?.[1];
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
