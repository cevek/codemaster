// Real-process harness for the watchdog smoke (t-095661) — spawned by `watchdog-smoke.test.ts`,
// NOT a test itself (no `.test.ts` suffix → the runner skips it). It exercises the two things a
// fake-clock unit cannot: a real worker thread reaping a genuinely wedged main loop, and a real
// orphaned child self-exiting when its parent dies. Config comes from env so the test drives tiny
// thresholds. Modes (argv[2]):
//   wedge         — install the watchdog, stamp a breadcrumb, then SYNC-spin forever. The worker
//                   must write a stall record and SIGKILL us.
//   orphan-parent — spawn `orphan-child` detached, then exit → the child is orphaned.
//   orphan-child  — install the watchdog (orphan-aware); on the orphan SIGTERM, write a marker and
//                   exit(0). Proves the main-loop poll detects the dead parent and shuts down.

import process from 'node:process';
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { installWatchdog } from '../../src/support/watchdog/install.ts';
import { beacon } from '../../src/support/watchdog/beacon.ts';
import { systemClock } from '../../src/common/async/clock.ts';

const mode = process.argv[2];

if (mode === 'wedge') {
  installWatchdog({ clock: systemClock, orphanAware: false });
  // Stamp the breadcrumb, then wedge the main loop: a synchronous infinite spin. The event loop is
  // now dead — only the worker thread can act (the whole point of backstop 1).
  void beacon.measure('op:wedge-test', { simulated: true }, () => {
    for (;;) {
      /* busy-loop — never yields */
    }
  });
} else if (mode === 'orphan-parent') {
  const self = fileURLToPath(import.meta.url);
  const child = spawn(process.execPath, [self, 'orphan-child'], {
    detached: true,
    stdio: 'ignore',
    env: process.env,
  });
  child.unref();
  // Record the child's pid so the test can assert the ROBUST invariant — the orphan is reaped, not
  // lingering — regardless of which backstop (graceful poll vs worker) wins the race.
  const pidFile = process.env['CODEMASTER_TEST_CHILD_PID_FILE'];
  if (pidFile !== undefined && child.pid !== undefined) {
    try {
      writeFileSync(pidFile, String(child.pid));
    } catch {
      /* best-effort */
    }
  }
  // Give the child time to install its watchdog, then exit so it is reparented (orphaned).
  setTimeout(() => process.exit(0), 200);
} else if (mode === 'orphan-child') {
  const marker = process.env['CODEMASTER_TEST_MARKER'];
  process.on('SIGTERM', () => {
    if (marker !== undefined) {
      try {
        writeFileSync(marker, 'orphaned-graceful');
      } catch {
        /* best-effort marker */
      }
    }
    process.exit(0);
  });
  installWatchdog({ clock: systemClock, orphanAware: true });
  // Keep the main loop alive (but idle) so the orphan poll can fire once the parent dies.
  setInterval(() => undefined, 1000);
} else if (mode === 'engine-child') {
  // The process-mode engine CHILD (t-350294): boot the real `serveEngineChild` over a fork IPC
  // channel. It arms the watchdog itself; the parent (the test) sends a `wedge` op request that
  // sync-spins the main loop through the engine's OWN `beacon.measure('op:wedge')` wrap — so the
  // worker thread reaps THIS child and names the running op in the stall breadcrumb. Config
  // (root/stateDir) arrives via env exactly as `forkEngineChild` supplies it.
  const root = process.env['CODEMASTER_ENGINE_ROOT'];
  if (root === undefined) {
    process.stderr.write('engine-child harness: CODEMASTER_ENGINE_ROOT not set\n');
    process.exit(2);
  }
  // Lazy — importing at top level would slow the OTHER (orphan-child) mode's watchdog install past
  // its parent's 200ms exit, disabling its orphan poll (ppid already 1).
  const { z } = await import('zod');
  const { serveEngineChild } = await import('../../src/daemon/engine-child.ts');
  const { defineOp } = await import('../../src/ops/registry.ts');
  // NO plugins: the engine wraps EVERY op in `beacon.measure` regardless of the plugin set, and the
  // wedge op needs none (`requires: []`). Skipping the ts plugin's TS-program build keeps this real
  // fork CHEAP — a heavy build would CPU-starve the neighbouring real-spawn e2e (orphan poll,
  // daemon-cli) under node:test's parallel file execution and flake THEM, not us.
  const wedgeOp = defineOp({
    name: 'wedge',
    summary: 'test-only: sync-wedge the main loop (never resolves)',
    mutating: false,
    requires: [],
    argsSchema: z.object({}).passthrough(),
    argsHint: '{}',
    run: async () => {
      for (;;) {
        /* busy-loop — never yields; the engine's beacon wrap already stamped op:wedge */
      }
    },
  });
  void serveEngineChild({
    root,
    version: 'test',
    stateDir: process.env['CODEMASTER_ENGINE_STATE_DIR'] ?? root,
    pluginsFor: () => [],
    opsFor: () => [wedgeOp],
  });
} else {
  process.stderr.write(`unknown harness mode: ${String(mode)}\n`);
  process.exit(2);
}
