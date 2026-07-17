// Real-subprocess smoke for `process`-mode engine isolation (ARCHITECTURE.md §2/§9). Unit tests
// (process-host.test.ts) cover the deadline/crash LOGIC deterministically with a fake child; these
// exercise what only a real fork can prove and a fake never catches — actual JSON-over-IPC parity,
// teardown, and the anti-orphan disconnect. Every wait is EVENT-DRIVEN with a generous bounded
// budget (never `sleep N → assert`), and each case uses its OWN temp dir + kills only its OWN pids,
// so parallel/slow CI stays green.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createProcessHost } from '../../src/daemon/process-host.ts';
import { forkEngineChild } from '../../src/daemon/fork-engine.ts';
import { createEngine } from '../../src/daemon/engine.ts';
import { Orchestrator } from '../../src/daemon/orchestrator.ts';
import { builtinPlugins } from '../../src/daemon/builtin-plugins.ts';
import { builtinOps } from '../../src/ops/builtins.ts';
import { loadConfig } from '../../src/support/config-load/load.ts';
import { canonicalizeRoot } from '../../src/support/fs/canonicalize.ts';
import { isOk } from '../../src/common/result/narrow.ts';
import { systemClock } from '../../src/common/async/clock.ts';
import { createDebugSystem } from '../../src/support/debug/system.ts';
import { nullWatcher } from '../../src/support/watch/seam.ts';
import type { RepoId } from '../../src/core/brands.ts';
import type { OpRequest } from '../../src/ops/contracts.ts';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const BIN = path.join(repoRoot, 'src', 'bin.ts');
const GENEROUS_MS = 90_000; // slow CI: cold fork + LS build; bounded, never a fixed sleep.

/** Mount a tiny TS project that opts into `process` isolation. Returns the canonical root. */
function makeRepo(): { root: string; stateDir: string; cleanup: () => void } {
  const dir = mkdtempSync(path.join(tmpdir(), 'cm-proc-'));
  mkdirSync(path.join(dir, 'src'));
  writeFileSync(
    path.join(dir, 'codemaster.config.ts'),
    `export default { daemon: { isolation: 'process' } };\n`,
  );
  writeFileSync(
    path.join(dir, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: {
        strict: true,
        module: 'ESNext',
        moduleResolution: 'bundler',
        noEmit: true,
      },
      include: ['src'],
    }),
  );
  writeFileSync(
    path.join(dir, 'src', 'thing.ts'),
    `export const thing = 42;\nexport const useThing = () => thing + thing;\n`,
  );
  const canon = canonicalizeRoot(dir);
  assert.ok(canon.ok, 'canonicalize temp root');
  const stateDir = path.join(dir, '.state');
  mkdirSync(stateDir);
  return {
    root: canon.ok ? canon.root : dir,
    stateDir,
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

test('parity: process-host results are byte-identical to an in-process engine', async () => {
  const { root, stateDir, cleanup } = makeRepo();
  const loaded = loadConfig(root);
  assert.ok(isOk(loaded));
  const config = loaded.data.config;
  const reqs: OpRequest[] = [
    { name: 'find_definition', args: { name: 'thing' } as never },
    { name: 'find_usages', args: { name: 'thing' } as never },
    { name: 'expand_type', args: { name: 'useThing' } as never },
  ];

  const ref = await createEngine({
    repoId: root as RepoId,
    root,
    configSource: loaded.data.source,
    version: 'test',
    stateDir,
    plugins: builtinPlugins(config, root),
    ops: builtinOps(),
    clock: systemClock,
    debug: createDebugSystem(systemClock),
    watcher: nullWatcher,
  });
  assert.ok(ref.ok);
  const refResults = ref.ok ? await ref.engine.request(reqs) : [];
  if (ref.ok) await ref.engine.dispose();

  const proc = await createProcessHost({
    repoId: root as RepoId,
    clock: systemClock,
    spawn: () =>
      forkEngineChild({
        binPath: BIN,
        root,
        stateDir,
        version: 'test',
        maxOldSpaceMB: 2048,
        sockDir: undefined,
      }),
    startupDeadlineMs: GENEROUS_MS,
    requestDeadlineMs: GENEROUS_MS,
    disposeDeadlineMs: 5_000,
    onExit: () => undefined,
  });
  assert.ok(proc.ok, proc.ok ? '' : proc.message);
  const procResults = proc.ok ? await proc.host.request(reqs) : [];
  if (proc.ok) await proc.host.dispose();

  assert.equal(JSON.stringify(procResults), JSON.stringify(refResults), 'process ≡ in-process');
  cleanup();
});

test('crash + respawn: a SIGKILLed child fails honestly, then the next request respawns', async () => {
  const { root, stateDir, cleanup } = makeRepo();
  const pids: number[] = [];
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
        requestDeadlineMs: GENEROUS_MS,
        disposeDeadlineMs: 5_000,
        onExit,
      }),
  });

  const first = await orch.request(root, root, [
    { name: 'find_definition', args: { name: 'thing' } as never },
  ]);
  const firstR = first.ok ? first.results[0] : undefined;
  assert.ok(
    firstR !== undefined && 'result' in firstR && firstR.result.ok,
    'first request warms + answers',
  );
  assert.equal(pids.length, 1, 'one child spawned');
  const dead = pids[0];
  assert.ok(dead !== undefined);

  process.kill(dead, 'SIGKILL');
  // Event-driven: the OS reaps the child, the `exit` event fires markDead → onExit evicts the slot.
  assert.ok(
    await waitUntil(() => !alive(dead) && orch.daemonInfo().engines === 0),
    'child dies and slot is evicted',
  );

  const second = await orch.request(root, root, [
    { name: 'find_definition', args: { name: 'thing' } as never },
  ]);
  const secondR = second.ok ? second.results[0] : undefined;
  assert.ok(
    secondR !== undefined && 'result' in secondR && secondR.result.ok,
    'next request respawns + answers',
  );
  assert.equal(pids.length, 2, 'a FRESH child was spawned');
  assert.notEqual(pids[0], pids[1], 'the respawn is a distinct process');

  await orch.dispose();
  cleanup();
});

test('anti-orphan: a SIGKILLed parent takes its engine child down (no squatting LS)', async () => {
  const { root, stateDir, cleanup } = makeRepo();
  // A minimal REAL parent: fork one engine child, print its pid once it is ready, then idle keeping
  // the IPC channel open. Killing this parent must make the child self-exit via `disconnect` (§9).
  const harness = path.join(stateDir, 'parent-harness.mjs');
  writeFileSync(
    harness,
    `import { forkEngineChild } from ${JSON.stringify(path.join(repoRoot, 'src', 'daemon', 'fork-engine.ts'))};\n` +
      `const h = forkEngineChild({ binPath: ${JSON.stringify(BIN)}, root: ${JSON.stringify(root)}, stateDir: ${JSON.stringify(stateDir)}, version: 'test', maxOldSpaceMB: 2048, sockDir: undefined });\n` +
      `h.onMessage((m) => { if (m && m.kind === 'ready') process.stdout.write('READY:' + h.pid + '\\n'); });\n` +
      `setInterval(() => {}, 1000);\n`,
  );
  const parent = spawn(process.execPath, [harness], {
    cwd: repoRoot,
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  let childPid: number | undefined;
  parent.stdout.on('data', (d: Buffer) => {
    const m = /READY:(\d+)/.exec(d.toString());
    if (m?.[1] !== undefined) childPid = Number(m[1]);
  });

  assert.ok(
    await waitUntil(() => childPid !== undefined && alive(childPid)),
    'engine child came up under the parent',
  );
  const gpid = childPid;
  assert.ok(gpid !== undefined);

  parent.kill('SIGKILL'); // the parent dies WITHOUT disposing — only `disconnect` can save the child
  assert.ok(
    await waitUntil(() => !alive(gpid)),
    'the orphaned engine child self-exits on disconnect',
  );

  cleanup();
});
