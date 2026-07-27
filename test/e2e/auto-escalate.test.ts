// t-754922 — auto-escalation: an OVERSIZED workspace is raised into `process` isolation at spawn
// even under the `in-process` default, with NO codemaster.config (the repos that need it have none).
//
// These assert BEHAVIOUR, not the presence of a function:
//  · the decision under PRODUCTION defaults — a real git repo of 4001 source files, no config file
//    at all, measured by the real `git ls-files` against the real default threshold;
//  · that the decision really FORKS — a live Orchestrator + real `forkEngineChild`, proven by an
//    OS-live child pid and the host reporting `process`, not by a boolean;
//  · that a fatal in that auto-escalated child reaches the client as a structural `ToolFailure`
//    while the daemon stays alive and respawns (the whole point: convert the crash, don't relocate);
//  · the discriminating negative — codemaster's OWN repo (~629 files) stays `in-process`, so the
//    dev-default single-heap debugging (§2) is not silently traded away.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createProcessHost } from '../../src/daemon/process-host.ts';
import { forkEngineChild } from '../../src/daemon/fork-engine.ts';
import { Orchestrator } from '../../src/daemon/orchestrator.ts';
import { builtinPlugins } from '../../src/daemon/builtin-plugins.ts';
import { builtinOps } from '../../src/ops/builtins.ts';
import { resolveIsolation, resetIsolationMemo } from '../../src/daemon/escalate.ts';
import { canonicalizeRoot } from '../../src/support/fs/canonicalize.ts';
import { systemClock } from '../../src/common/async/clock.ts';
import { createDebugSystem } from '../../src/support/debug/system.ts';
import { nullWatcher } from '../../src/support/watch/seam.ts';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const BIN = path.join(repoRoot, 'src', 'bin.ts');
const GENEROUS_MS = 90_000;

/** A real git repo (the size estimate is a real `git ls-files`) with `fileCount` source files and,
 *  optionally, a config. `config: undefined` is the production shape: NO config file at all. */
function makeGitRepo(fileCount: number, config?: string): { root: string; cleanup: () => void } {
  const dir = mkdtempSync(path.join(tmpdir(), 'cm-esc-'));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  mkdirSync(path.join(dir, 'src'));
  for (let i = 0; i < fileCount; i += 1) {
    writeFileSync(path.join(dir, 'src', `f${i}.ts`), `export const v${i} = ${i};\n`);
  }
  writeFileSync(
    path.join(dir, 'tsconfig.json'),
    JSON.stringify({ compilerOptions: { strict: true, noEmit: true }, include: ['src'] }),
  );
  if (config !== undefined) writeFileSync(path.join(dir, 'codemaster.config.ts'), config);
  const canon = canonicalizeRoot(dir);
  assert.ok(canon.ok, 'canonicalize temp root');
  return {
    root: canon.ok ? canon.root : dir,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

function alive(pid: number | undefined): boolean {
  if (pid === undefined) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitUntil(pred: () => boolean, budgetMs = GENEROUS_MS): Promise<boolean> {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return pred();
}

// ── the decision, under PRODUCTION defaults (no config, real git, real 4000 threshold) ──────────

test('4001-file git repo with NO config → escalates; the same repo with autoEscalate:false or an explicit mode does NOT', () => {
  const big = makeGitRepo(4001);
  try {
    resetIsolationMemo();
    const auto = resolveIsolation(big.root, {}, true);
    assert.equal(auto.isolation, 'process', 'an oversized repo escalates under bare defaults');
    assert.equal(auto.reason, 'auto-escalated');
    assert.equal(auto.threshold, 4000, 'compared against the real shipped default');
    assert.ok(
      auto.files !== undefined && auto.files > 4000,
      `real git count must exceed the threshold, got ${String(auto.files)}`,
    );

    // The escape hatch really pins the old behaviour.
    resetIsolationMemo();
    const pinned = resolveIsolation(big.root, { daemon: { autoEscalate: false } }, true);
    assert.equal(pinned.isolation, 'in-process', 'autoEscalate:false pins in-process');
    assert.equal(pinned.reason, 'auto-escalate-disabled');

    // An explicit mode always wins — the two knobs are not competing.
    resetIsolationMemo();
    const explicit = resolveIsolation(big.root, { daemon: { isolation: 'in-process' } }, true);
    assert.equal(explicit.isolation, 'in-process');
    assert.equal(explicit.reason, 'configured');

    // Escalation wanted but unavailable → in-process (never a silent claim of isolation we lack).
    resetIsolationMemo();
    const noFactory = resolveIsolation(big.root, {}, false);
    assert.equal(noFactory.isolation, 'in-process');
    assert.equal(noFactory.reason, 'no-process-host');
  } finally {
    big.cleanup();
  }
});

// The discriminating negative on a REAL repo, not a fixture: codemaster itself must stay in-process,
// else the whole project silently moves to process-mode and loses the §2 single-heap dev default.
test('codemaster’s own repo (~629 files) does NOT escalate — the dev default survives', () => {
  resetIsolationMemo();
  const d = resolveIsolation(repoRoot, {}, true);
  assert.equal(d.isolation, 'in-process', `codemaster must stay in-process, got ${d.reason}`);
  assert.equal(d.reason, 'within-budget');
  assert.ok(d.files !== undefined && d.files < 4000, `real self-count: ${String(d.files)}`);
});

test('a non-git root (size unmeasurable) never escalates on unknown', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'cm-esc-nogit-'));
  try {
    resetIsolationMemo();
    const d = resolveIsolation(dir, {}, true);
    assert.equal(d.isolation, 'in-process');
    assert.equal(d.reason, 'estimate-failed');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── the decision really FORKS, and a fatal in that child is structural ───────────────────────────

// Scope note: the fatal driven here is the §9 kill-on-deadline (requestDeadlineMs=1 → the child is
// SIGKILLed mid-request), which is what a test can force deterministically in seconds. The OOM
// flavour of the same conversion was verified live on a real 6.1k-file repo with no config at all
// (`FAIL tool=oom — isolated engine process ran out of memory`, daemon alive) — unreproducible here
// without a multi-minute real warm. Both arrive through this one path: child dies → structured
// failure → slot evicted → respawn.
test('oversized repo, no isolation configured: the orchestrator really forks a child; a child fatal (kill-on-deadline) is a structural ToolFailure and the daemon respawns', async () => {
  // A small repo with a LOW threshold is the same decision path as 4001-files-vs-4000, but forks in
  // seconds. (The default-threshold half is proven above, on a real 4001-file repo.) Note the config
  // sets NO `daemon.isolation` — process-mode here is the auto-escalation, not an opt-in.
  const { root, cleanup } = makeGitRepo(3, `export default { ts: { searchWarmMaxFiles: 1 } };\n`);
  const stateDir = path.join(root, '.state');
  mkdirSync(stateDir);
  const pids: number[] = [];
  let deadlineMs = 1; // the first request can never complete → the §9 kill-on-deadline path
  resetIsolationMemo();
  const orch = new Orchestrator({
    clock: systemClock,
    debug: createDebugSystem(systemClock),
    watcher: nullWatcher,
    version: 'test',
    stateDir,
    pluginsFor: builtinPlugins,
    opsFor: () => builtinOps(),
    spawnProcessHost: ({ repoId, root: r, stateDir: sd, onExit }) =>
      createProcessHost({
        repoId,
        clock: systemClock,
        spawn: () => {
          const h = forkEngineChild({
            binPath: BIN,
            root: r,
            stateDir: sd,
            version: 'test',
            maxOldSpaceMB: 2048,
            sockDir: undefined,
          });
          if (h.pid !== undefined) pids.push(h.pid);
          return h;
        },
        startupDeadlineMs: GENEROUS_MS,
        requestDeadlineMs: deadlineMs,
        disposeDeadlineMs: 5_000,
        onExit,
      }),
  });

  try {
    const first = await orch.request(root, root, [
      { name: 'find_usages', args: { name: 'v0' } as never },
    ]);
    // A REAL child was forked without anyone configuring `isolation` — the escalation itself.
    assert.equal(pids.length, 1, 'the oversized repo was hosted in a forked child');
    assert.ok(pids[0] !== undefined, 'the child pid was recorded');

    const firstR = first.ok ? first.results[0] : undefined;
    assert.ok(
      firstR !== undefined && 'result' in firstR && firstR.result.ok === false,
      'a fatal in the escalated child reaches the client as a structured failure, not a throw',
    );
    assert.equal(
      firstR !== undefined && 'result' in firstR && !firstR.result.ok
        ? firstR.result.failure.tool
        : undefined,
      'timeout',
      'and it is the kill-on-deadline conversion, not an unrelated failure (e.g. a child that never started)',
    );
    // The daemon is ALIVE right after that fatal — it answers its own state.
    assert.ok(orch.daemonInfo().pid > 0, 'daemon survives the child fatal');
    assert.ok(
      await waitUntil(() => !alive(pids[0]) && orch.daemonInfo().engines === 0),
      'the dead child is reaped and its slot evicted',
    );

    deadlineMs = GENEROUS_MS;
    const second = await orch.request(root, root, [
      { name: 'find_usages', args: { name: 'v0' } as never },
    ]);
    const secondR = second.ok ? second.results[0] : undefined;
    assert.ok(
      secondR !== undefined && 'result' in secondR && secondR.result.ok,
      'the next request respawns an escalated child and answers',
    );
    assert.equal(pids.length, 2, 'a FRESH child was spawned');
  } finally {
    await orch.dispose();
    cleanup();
  }
});

// A FAILED fork must not kill the workspace: escalation was OUR decision, not the user's request, so
// the fallback keeps the cheap no-warm ops answering (they worked before escalation existed) and only
// the heavy fan-out is refused — with the fork failure named as the cause.
test('escalation whose fork FAILS degrades to in-process: cheap ops still answer, the heavy one refuses naming the failed fork', async () => {
  const { root, cleanup } = makeGitRepo(3, `export default { ts: { searchWarmMaxFiles: 1 } };\n`);
  const stateDir = path.join(root, '.state');
  mkdirSync(stateDir);
  resetIsolationMemo();
  const orch = new Orchestrator({
    clock: systemClock,
    debug: createDebugSystem(systemClock),
    watcher: nullWatcher,
    version: 'test',
    stateDir,
    pluginsFor: builtinPlugins,
    opsFor: () => builtinOps(),
    spawnProcessHost: () => Promise.resolve({ ok: false as const, message: 'fork blew up' }),
  });
  try {
    // A no-warm op must still work — the whole workspace must NOT be dead.
    const cheap = await orch.request(root, root, [{ name: 'symbols_overview', args: {} as never }]);
    const c0 = cheap.ok ? cheap.results[0] : undefined;
    assert.ok(
      c0 !== undefined && 'result' in c0 && c0.result.ok,
      `a failed escalation must not kill cheap ops: ${JSON.stringify(cheap)}`,
    );

    const heavy = await orch.request(root, root, [
      { name: 'find_usages', args: { name: 'v0' } as never },
    ]);
    const h0 = heavy.ok ? heavy.results[0] : undefined;
    assert.ok(h0 !== undefined && 'result' in h0 && !h0.result.ok, 'the heavy op refuses');
    if (h0 !== undefined && 'result' in h0 && !h0.result.ok) {
      assert.match(h0.result.failure.message, /forking the isolated child engine failed/);
    }
  } finally {
    await orch.dispose();
    cleanup();
  }
});

// Same repo, escalation switched OFF → no child at all (the escape hatch really pins the old path).
test('autoEscalate:false on the same oversized repo → NO child is forked', async () => {
  const { root, cleanup } = makeGitRepo(
    3,
    `export default { ts: { searchWarmMaxFiles: 1 }, daemon: { autoEscalate: false } };\n`,
  );
  const stateDir = path.join(root, '.state');
  mkdirSync(stateDir);
  let forks = 0;
  resetIsolationMemo();
  const orch = new Orchestrator({
    clock: systemClock,
    debug: createDebugSystem(systemClock),
    watcher: nullWatcher,
    version: 'test',
    stateDir,
    pluginsFor: builtinPlugins,
    opsFor: () => builtinOps(),
    spawnProcessHost: () => {
      forks += 1;
      return Promise.resolve({ ok: false as const, message: 'must not be called' });
    },
  });
  try {
    const res = await orch.request(root, root, [
      { name: 'find_usages', args: { name: 'v0' } as never },
    ]);
    assert.equal(forks, 0, 'a pinned workspace must never fork');
    const r0 = res.ok ? res.results[0] : undefined;
    // In-process + oversized → the guard refuses honestly and names the pin as the cause.
    assert.ok(r0 !== undefined && 'result' in r0 && r0.result.ok === false);
    if (r0 !== undefined && 'result' in r0 && !r0.result.ok) {
      assert.match(r0.result.failure.message, /autoEscalate/);
    }
  } finally {
    await orch.dispose();
    cleanup();
  }
});
