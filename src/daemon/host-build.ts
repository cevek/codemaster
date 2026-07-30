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
import { resolveIsolation } from './escalate.ts';
import type { IsolationReason } from '../core/isolation.ts';
import { createInProcessHost } from './in-process-host.ts';
import type { ProjectHost } from './host.ts';
import type { OrchestratorDeps } from './orchestrator-deps.ts';

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
  /** The §4c refusal for this root, when it has one — see `EngineDeps.workspaceUnsupported`. */
  workspaceUnsupported?: string;
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
  const { repoId, root, config, source, workspaceUnsupported } = args;
  if (config.debug?.namespaces !== undefined && config.debug.namespaces.length > 0) {
    deps.debug.configure(config.debug.namespaces.join(','));
  }
  const home = process.env['HOME'] ?? process.env['USERPROFILE'] ?? '/tmp';
  const stateDir = deps.stateDir ?? path.join(home, '.codemaster');

  // The isolation DECISION (§2/§9, t-754922): the config's explicit mode, else auto-escalation for
  // an oversized repo. Taken here, before any engine exists, off a host-free git count that the
  // downstream fan-out guard re-derives from the same function + threshold (see escalate.ts).
  const decision = resolveIsolation(root, config, deps.spawnProcessHost !== undefined);
  // Traced with the CAUSE, always — an auto-escalated repo silently forking a child would be a
  // capability change the user (notably one who chose `--in-process` to debug) never saw (§3.6).
  deps.debug.ns('daemon')('isolation resolved', () => ({
    repo: repoId,
    isolation: decision.isolation,
    reason: decision.reason,
    ...(decision.files !== undefined ? { files: decision.files } : {}),
    ...(decision.threshold !== undefined ? { threshold: decision.threshold } : {}),
  }));

  // Set when an AUTO escalation was decided but its fork failed: the engine below is built
  // in-process instead, and THIS is the reason it reports (the decision object stays immutable).
  let fallbackReason: IsolationReason | undefined;

  if (decision.isolation === 'process') {
    const factory = deps.spawnProcessHost;
    if (factory === undefined) {
      // Unreachable for an AUTO escalation (it degrades to in-process when no factory exists —
      // escalate.ts); this is the EXPLICIT `isolation:'process'` request, which must fail honestly
      // rather than silently run in a mode the user did not ask for.
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
    if (spawned.ok) {
      ref.host = spawned.host;
      return { ok: true, host: spawned.host };
    }
    // A fork that FAILS (cold-machine startup deadline, EAGAIN, an unreachable child bin) must not
    // kill the whole workspace: an AUTO escalation was our decision, not the user's request, and
    // failing it hard would take down the cheap no-warm ops (symbols_overview, syntactic search)
    // that worked before escalation existed. Degrade to in-process and record WHY, so the fan-out
    // guard still refuses the heavy ops honestly. An EXPLICIT `isolation:'process'` keeps failing
    // hard — a user told which mode they want is told when they cannot have it.
    if (decision.reason !== 'auto-escalated') return spawned;
    deps.debug.ns('daemon')('escalation fork failed — degrading to in-process', () => ({
      repo: repoId,
      error: spawned.message,
    }));
    fallbackReason = 'escalation-failed';
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
    ...(workspaceUnsupported !== undefined ? { workspaceUnsupported } : {}),
    version: deps.version,
    stateDir,
    isolation: 'in-process',
    isolationReason: fallbackReason ?? decision.reason,
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
