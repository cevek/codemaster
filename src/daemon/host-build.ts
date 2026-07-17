// Build a workspace host for the resolved isolation mode (§2), factored out of the orchestrator
// so its routing/lifecycle file stays under the line cap. `in-process` warms the engine in the
// orchestrator's own process; `process` forks one child per workspace (the child owns its own
// debug/log + engine build). Config-driven, never a code toggle.

import * as path from 'node:path';
import process from 'node:process';
import type { CodemasterConfig } from '../config/config.ts';
import type { RepoId } from '../core/brands.ts';
import { attachRepoLogSink } from './repo-log-sink.ts';
import { createEngine } from './engine.ts';
import { createInProcessHost } from './in-process-host.ts';
import type { ProjectHost } from './host.ts';
import type { OrchestratorDeps } from './orchestrator.ts';

/** Default per-op cooperative wall-clock budget (§1 never-hang, config `daemon.opDeadlineSeconds`).
 *  120 s — comfortably above the legitimate 5–60 s answer ceiling (§1), so it fires only on a
 *  runaway call, never a slow-but-valid one; and shorter than the process-mode kill backstop (§9),
 *  so the cooperative partial returns before any hard SIGKILL. */
export const DEFAULT_OP_DEADLINE_SECONDS = 120;

export interface HostBuildArgs {
  repoId: RepoId;
  root: string;
  config: CodemasterConfig;
  source: string | undefined;
}

export type HostBuildResult = { ok: true; host: ProjectHost } | { ok: false; message: string };

/** `evictIfCurrent(host)` removes the engine slot iff it still holds exactly `host` — the
 *  orchestrator's identity-guarded eviction, called when a process child dies so the next request
 *  respawns (a dead host left in the map would be reused forever). Passed a possibly-undefined host
 *  on a startup death, where no slot matches. */
export async function buildWorkspaceHost(
  deps: OrchestratorDeps,
  args: HostBuildArgs,
  evictIfCurrent: (host: ProjectHost | undefined) => void,
): Promise<HostBuildResult> {
  const { repoId, root, config, source } = args;
  if (config.debug?.namespaces !== undefined && config.debug.namespaces.length > 0) {
    deps.debug.configure(config.debug.namespaces.join(','));
  }
  const home = process.env['HOME'] ?? process.env['USERPROFILE'] ?? '/tmp';
  const stateDir = deps.stateDir ?? path.join(home, '.codemaster');

  if (config.daemon?.isolation === 'process') {
    const factory = deps.spawnProcessHost;
    if (factory === undefined) {
      return {
        ok: false,
        message:
          "daemon.isolation 'process' needs a process-host factory this build does not provide — set 'in-process' in codemaster.config",
      };
    }
    // The child owns its own per-repo debug log (same stateDir) — the orchestrator does NOT attach
    // one for a process host, so two processes never interleave the same rotating file. A holder
    // lets `onExit` (wired before the host exists) compare against the resolved host.
    const ref: { host?: ProjectHost } = {};
    const spawned = await factory({
      repoId,
      root,
      config,
      stateDir,
      onExit: () => evictIfCurrent(ref.host),
    });
    if (!spawned.ok) return spawned;
    ref.host = spawned.host;
    return { ok: true, host: spawned.host };
  }

  // Per-repo debug log (§13): ~/.codemaster/<repoKey>/debug.log, routed by repoId.
  attachRepoLogSink(deps.debug, stateDir, repoId, root, config.debug?.logMaxMB);
  // Per-op cooperative wall-clock budget (§1): a direct `opDeadlineMs` dep (test seam) wins,
  // else the config seconds (default 120) × 1000. The engine treats it as a hard bound.
  const deadlineSec = config.daemon?.opDeadlineSeconds ?? DEFAULT_OP_DEADLINE_SECONDS;
  const created = await createEngine({
    repoId,
    root,
    configSource: source,
    version: deps.version,
    stateDir,
    isolation: 'in-process',
    plugins: deps.pluginsFor?.(config, root) ?? [],
    ops: deps.opsFor?.(config) ?? [],
    clock: deps.clock,
    opDeadlineMs: deps.opDeadlineMs ?? deadlineSec * 1000,
    debug: deps.debug,
    watcher: deps.watcher,
    ...(deps.sqlBounds !== undefined ? { sqlBounds: deps.sqlBounds } : {}),
    ...(deps.createSqlRunner !== undefined ? { createSqlRunner: deps.createSqlRunner } : {}),
    ...(deps.createTextScanner !== undefined ? { createTextScanner: deps.createTextScanner } : {}),
    ...(deps.gitRunner !== undefined ? { gitRunner: deps.gitRunner } : {}),
  });
  if (!created.ok) return { ok: false, message: created.message };
  return { ok: true, host: createInProcessHost(created.engine) };
}
