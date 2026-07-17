// The composition wiring for `process`-mode isolation (§2/§9): binds the child bin path +
// deadlines into the `spawnProcessHost` factory the orchestrator calls. Split from bin.ts so the
// composition root stays under the line cap; the factory itself holds no state.

import { systemClock } from '../common/async/clock.ts';
import { createProcessHost } from './process-host.ts';
import { forkEngineChild } from './fork-engine.ts';
import type { OrchestratorDeps } from './orchestrator.ts';

/** Child build+ready handshake bound (§1); LS warm is lazy so this is short. */
const STARTUP_DEADLINE_MS = 60_000;
/** SIGTERM→SIGKILL grace on dispose. */
const DISPOSE_DEADLINE_MS = 5_000;
/** Default child heap ceiling (`--max-old-space-size`, MB) when config sets none — ≥ Node's own
 *  ~4 GB so a legitimately large repo isn't killed needlessly; a repo that blows it OOMs the child
 *  honestly (the daemon survives), which is exactly the isolation guarantee (t-167395). */
const DEFAULT_MAX_OLD_SPACE_MB = 4096;

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
}

export function makeProcessHostFactory(
  opts: ProcessHostFactoryOpts,
): NonNullable<OrchestratorDeps['spawnProcessHost']> {
  return ({ repoId, root, config, stateDir, onExit }) =>
    createProcessHost({
      repoId,
      clock: systemClock,
      spawn: () =>
        forkEngineChild({
          binPath: opts.binPath,
          root,
          stateDir,
          version: opts.version,
          maxOldSpaceMB: config.daemon?.maxOldSpaceMB ?? DEFAULT_MAX_OLD_SPACE_MB,
          sockDir: opts.sockDir,
        }),
      startupDeadlineMs: STARTUP_DEADLINE_MS,
      requestDeadlineMs: opts.requestDeadlineMs,
      disposeDeadlineMs: DISPOSE_DEADLINE_MS,
      onExit,
    });
}
