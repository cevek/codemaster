// `OrchestratorDeps` — everything the front door is constructed with: the injectable seams (clock,
// watcher, debug, git/sql/text-scanner factories) plus the composition root's plugin/op providers and
// the process-host factory. The orchestrator-side twin of `engine-deps.ts`, split out for the same
// reason: `orchestrator.ts` is routing + lifecycle + governor, and its line cap is for that code.

import type { RepoId } from '../core/brands.ts';
import type { Plugin } from '../core/plugin.ts';
import type { AnyOpDefinition } from '../ops/registry.ts';
import type { Clock } from '../common/async/clock.ts';
import type { SqlBounds } from './sql-batch.ts';
import type { createSqliteRunner } from '../support/sql/better-sqlite3.ts';
import type { TextScanner } from '../support/text-search/scan.ts';
import type { GitRunner } from '../support/git/run.ts';
import type { DebugSystemHandle } from '../support/debug/system.ts';
import type { Watcher } from '../support/watch/seam.ts';
import type { CodemasterConfig } from '../config/config.ts';
import type { ProjectHost } from './host.ts';

export interface OrchestratorDeps {
  clock: Clock;
  debug: DebugSystemHandle;
  watcher: Watcher;
  version: string;
  /** Composition root injects available plugins/ops per workspace. */
  pluginsFor?: (config: CodemasterConfig, root: string) => readonly Plugin[];
  opsFor?: (config: CodemasterConfig) => readonly AnyOpDefinition[];
  /** Where per-repo debug logs live; default `~/.codemaster`. */
  stateDir?: string;
  /** Engine-count budget for the in-process governor (LRU-evicted past this). */
  maxEngines?: number;
  /** sql-mode row bounds (§2.3/§2.4) — test seam, forwarded to every engine. */
  sqlBounds?: Partial<SqlBounds>;
  /** SQL evaluator factory (§4) — test seam, forwarded to every engine. */
  createSqlRunner?: () => ReturnType<typeof createSqliteRunner>;
  /** Text-scanner factory (§ text-overlay) — test seam, forwarded to every engine. */
  createTextScanner?: () => TextScanner;
  /** Git runner for the freshness path (§3.6) — test seam, forwarded to every engine. */
  gitRunner?: GitRunner;
  /** Per-op cooperative wall-clock budget in ms (§1 never-hang) — test seam. When set, OVERRIDES
   *  the config-derived `daemon.opDeadlineSeconds`, so a timeout test can force the degrade with a
   *  `0` (immediately-expired) budget without writing a config file. Production leaves it unset and
   *  the config default (`daemon.opDeadlineSeconds`, 120 s) applies. */
  opDeadlineMs?: number;
  /** Codemaster's OWN source fingerprint (self-staleness — §3.6). Recorded at spawn; a later
   *  difference means the daemon is behind its source. Test seam; default = `src/**` rollup. */
  sourceFingerprint?: () => string;
  /** Build a `process`-mode host (§2): fork one engine child per workspace. Injected by the
   *  composition root (it knows the child bin path); absent in builds without process support, so
   *  `isolation: 'process'` then fails honestly rather than silently degrading to in-process.
   *  `onExit` fires when the child dies — the orchestrator evicts the slot so the next request
   *  respawns. */
  spawnProcessHost?: (args: {
    repoId: RepoId;
    root: string;
    config: CodemasterConfig;
    stateDir: string;
    onExit: () => void;
  }) => Promise<{ ok: true; host: ProjectHost } | { ok: false; message: string }>;
}
