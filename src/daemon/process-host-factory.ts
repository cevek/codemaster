// The composition wiring for `process`-mode isolation (§2/§9): binds the child bin path +
// deadlines into the `spawnProcessHost` factory the orchestrator calls. Split from bin.ts so the
// composition root stays under the line cap; the factory itself holds no state.

import os from 'node:os';
import process from 'node:process';
import { systemClock } from '../common/async/clock.ts';
import { createProcessHost } from './process-host.ts';
import { forkEngineChild, type EngineChildHandle, type ForkEngineOpts } from './fork-engine.ts';
import { boxMemoryBytes, describeCeiling, resolveChildHeapMB } from './heap-ceiling.ts';
import type { OrchestratorDeps } from './orchestrator-deps.ts';
import type { Debugger } from '../core/debug.ts';

/** Child build+ready handshake bound (§1); LS warm is lazy so this is short. */
const STARTUP_DEADLINE_MS = 60_000;
/** SIGTERM→SIGKILL grace on dispose. */
const DISPOSE_DEADLINE_MS = 5_000;

export interface ProcessHostFactoryOpts {
  /** This same bin, re-invoked as `daemon serve-engine` (its `import.meta.url` base is
   *  codemaster's own source, so the child resolves the SAME bundled TS — §19). */
  binPath: string;
  version: string;
  /** Per-request deadline — aligned with the bridge's (same order — a legitimately slow cold
   *  warm+heavy op must not be false-killed). */
  requestDeadlineMs: number;
  /** Test socket-dir seam, forwarded so a spawned child shares the parent's endpoint config. */
  sockDir: string | undefined;
  /** Test seams (mirroring `createProcessHost`'s own `spawn` seam), so the resolved heap ceiling is
   *  assertable without forking a real child: the fork itself, and the box size the DEFAULT ceiling
   *  is derived from. Production passes neither — the real fork, and the real box (host RAM reduced
   *  to a cgroup limit where one applies). */
  forkChild?: (forkOpts: ForkEngineOpts) => EngineChildHandle;
  totalMemBytes?: number;
  /** `daemon`-namespace logger (§13). The ceiling decision is traced like its sibling isolation
   *  decision (`host-build.ts`), so which ceiling a child got — and who chose it — is greppable
   *  instead of only observable with `ps` from outside. */
  trace?: Debugger;
}

export function makeProcessHostFactory(
  opts: ProcessHostFactoryOpts,
): NonNullable<OrchestratorDeps['spawnProcessHost']> {
  const fork = opts.forkChild ?? forkEngineChild;
  return ({ repoId, root, config, stateDir, onExit }) => {
    // The child's heap ceiling (§9): the repo's own config verbatim, else derived from THIS box —
    // resolved per spawn (cheap, and a config differs per workspace), never a fixed default.
    const ceiling = resolveChildHeapMB(
      config,
      opts.totalMemBytes ?? boxMemoryBytes(os.totalmem(), process.constrainedMemory?.()),
    );
    opts.trace?.('child heap ceiling resolved', () => ({
      repo: repoId,
      mb: ceiling.maxOldSpaceMB,
      cause: ceiling.cause,
    }));
    return createProcessHost({
      repoId,
      clock: systemClock,
      // Carried, not just applied: an OOM failure names the ceiling that was exhausted and how to
      // move it — "too big for this machine" and "too big for the number we picked" are different
      // answers, and the agent cannot tell them apart from `code=134` alone (§3.6).
      heapCeiling: describeCeiling(ceiling),
      spawn: () =>
        fork({
          binPath: opts.binPath,
          root,
          stateDir,
          version: opts.version,
          maxOldSpaceMB: ceiling.maxOldSpaceMB,
          sockDir: opts.sockDir,
        }),
      startupDeadlineMs: STARTUP_DEADLINE_MS,
      requestDeadlineMs: opts.requestDeadlineMs,
      disposeDeadlineMs: DISPOSE_DEADLINE_MS,
      onExit,
    });
  };
}
