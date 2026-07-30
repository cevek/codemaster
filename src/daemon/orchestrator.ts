// The orchestrator (§2, §9): one front door, many workspaces. Holds NO project data —
// a `repoId → host` registry, routing (cwd/root → workspace), lifecycle (lazy
// spin-up, idle-TTL eviction, path-existence sweeper, engine-count governor), and the
// debug surface. It only routes; heavy work lives in the engines.

import { existsSync } from 'node:fs';
import { createSourceStaleTracker, type SourceStaleTracker } from './source-fingerprint.ts';
import type { RepoId } from '../core/brands.ts';
import type { BatchOptions, OpRequest, OpResult } from '../ops/contracts.ts';
import type { AnyOpDefinition } from '../ops/registry.ts';
import type { CancelTimer } from '../common/async/clock.ts';
import { messageOfThrown } from '../common/result/construct.ts';
import { isOk } from '../common/result/narrow.ts';
import type { SqlBounds } from './sql-batch.ts';
import { DEFAULT_MAX_RESULT_ROWS, DEFAULT_MAX_TABLE_ROWS } from '../support/sql/runner.ts';
import { createSqliteRunner } from '../support/sql/better-sqlite3.ts';
import {
  crossRootSql,
  groupedDispatch,
  type RouteOk,
  type RouteOutcome,
  type SpawnHost,
} from './multi-root.ts';
import { canonicalizeRoot } from '../support/fs/canonicalize.ts';
import { gitRepoRoot } from '../support/git/repo-root.ts';
import { gateWarmSlot, requiresTsProject, tsProjectRefusal } from './ts-project-check.ts';
import { loadConfig } from '../support/config-load/load.ts';
import { configChanged, configFingerprint } from '../support/config-load/fingerprint.ts';
import { buildWorkspaceHost } from './host-build.ts';
import type { ProjectHost } from './host.ts';
import type { EngineSlot } from './engine-slot.ts';
import type { OrchestratorDeps } from './orchestrator-deps.ts';
import type { StatusView, WorkspaceStatusView } from '../format/render/render-status.ts';
import type { DaemonInfo, ServingOrchestrator } from './orchestrator-api.ts';

/** Default idle TTL (minutes) — shared by per-engine eviction (§9) and the `mcp` server's
 *  process-level idle self-exit (spec-daemon-singleton Stage 1). */
export const DEFAULT_IDLE_EVICTION_MIN = 30;
const DEFAULT_SWEEP_SECONDS = 60;
const DEFAULT_MAX_ENGINES = 8;

export class Orchestrator implements ServingOrchestrator {
  private readonly deps: OrchestratorDeps;
  private readonly engines = new Map<RepoId, EngineSlot>();
  private readonly trace;
  private sweepTimer: CancelTimer | undefined;
  private disposed = false;
  private readonly startedAtMs: number;
  private readonly sourceTracker: SourceStaleTracker;

  constructor(deps: OrchestratorDeps) {
    this.deps = deps;
    this.trace = deps.debug.ns('daemon');
    this.startedAtMs = deps.clock.now();
    this.sourceTracker = createSourceStaleTracker(() => deps.clock.now(), deps.sourceFingerprint);
    this.scheduleSweep(DEFAULT_SWEEP_SECONDS);
  }

  /** True when codemaster's own source changed since spawn (§3.6 applied to the tool); an
   *  `unknown` baseline (global/npx) never fires. Used by `status` + the MCP op banner. */
  sourceStale(): boolean {
    return this.sourceTracker.stale();
  }

  /** Resolve the target workspace: explicit `root` wins; otherwise the git toplevel
   *  of `cwd`; otherwise `cwd` itself (non-git workspaces run on the mtime fallback). */
  async route(cwd: string, root?: string): Promise<RouteOutcome> {
    const base = root ?? cwd;
    if (root === undefined) {
      const git = await gitRepoRoot(cwd);
      if (git.state === 'git') return this.toRoute(git.root);
      if (git.state === 'error') this.trace('git root failed', () => ({ error: git.message }));
    }
    const canon = canonicalizeRoot(base);
    if (!canon.ok) return { ok: false, message: canon.message };
    return this.toRoute(canon.root);
  }

  async request(
    cwd: string,
    root: string | undefined,
    reqs: readonly OpRequest[],
    batch?: BatchOptions,
  ): Promise<{ ok: true; results: readonly OpResult[] } | { ok: false; message: string }> {
    // Resolve each request's effective root (request `root` > tool `root` > cwd) — a batch
    // may span sibling repos (cross-repo §1). Routes preserve request index.
    const routes = await Promise.all(reqs.map((req) => this.route(cwd, req.root ?? root)));
    const okRoutes = routes.filter((r): r is RouteOk => r.ok);
    const distinctRoots = new Set(okRoutes.map((r) => r.repoId));
    const singleEngineAllOk = distinctRoots.size === 1 && okRoutes.length === reqs.length;

    // Fast path — every request targets ONE engine and resolves cleanly: today's single
    // dispatch, byte-for-byte (one engine, one batch-entry freshness, sql in-engine §11).
    if (singleEngineAllOk) {
      const r0 = okRoutes[0];
      if (r0 === undefined) return { ok: true, results: [] };
      // §4c gate, per DISPATCH GROUP: this whole batch shares one engine, so it applies unless
      // EVERY op in it is workspace-independent (t-810757). Passed LAZILY: the answer costs a config
      // load, and the overwhelmingly common case — a warm slot already `verified` — never consults
      // it. Paying it per request on the hot path would tax exactly the repos whose verdict cannot
      // change (a config IS the explicit opt-in, so they are never refused).
      const spawned = await this.getOrSpawn(r0.repoId, r0.root, () =>
        requiresTsProject(reqs, this.opDefs(r0.root)),
      );
      if (!spawned.ok) return spawned;
      return { ok: true, results: await spawned.slot.host.request(reqs, batch) };
    }

    // Cross-root sql joins at the orchestrator (§2); other multi-root batches group by
    // engine and reassemble in original order. Both live in multi-root.ts.
    const spawn: SpawnHost = (repoId, repoRoot, requireTsProject) =>
      this.spawnHost(repoId, repoRoot, requireTsProject);
    const needsWorkspace = (groupReqs: readonly OpRequest[], repoRoot: string): boolean =>
      requiresTsProject(groupReqs, this.opDefs(repoRoot));
    if (batch?.sql !== undefined) {
      return {
        ok: true,
        results: await crossRootSql(reqs, routes, batch, {
          spawn,
          needsWorkspace,
          opDefs: (r) => this.opDefs(r),
          bounds: this.resolvedSqlBounds(),
          createRunner: () => (this.deps.createSqlRunner ?? createSqliteRunner)(),
        }),
      };
    }
    return { ok: true, results: await groupedDispatch(reqs, routes, batch, spawn, needsWorkspace) };
  }

  /** Adapt the engine-slot lifecycle to the thin `SpawnHost` the multi-root dispatch
   *  needs (it only wants the host, never the slot's internals). */
  private async spawnHost(
    repoId: RepoId,
    root: string,
    requireTsProject: boolean,
  ): Promise<{ ok: true; host: ProjectHost } | { ok: false; message: string }> {
    // The grouped dispatch already computed its group's verdict, so this arrives decided.
    const spawned = await this.getOrSpawn(repoId, root, () => requireTsProject);
    return spawned.ok ? { ok: true, host: spawned.slot.host } : spawned;
  }

  async status(cwd: string, root?: string): Promise<StatusView> {
    let workspace: WorkspaceStatusView | undefined;
    const routed = await this.route(cwd, root);
    // §4c: surface WHY no workspace resolved (bad root / not a TS project), never a silent none.
    let workspaceError = routed.ok ? undefined : routed.message;
    // The real transport of the resolved workspace's host (§2) — never a hard-coded guess.
    // No workspace resolved → the daemon's default mode.
    let isolation: 'in-process' | 'process' = 'in-process';
    if (routed.ok) {
      const spawned = await this.getOrSpawn(routed.repoId, routed.root);
      if (spawned.ok) {
        isolation = spawned.slot.host.isolation;
        // A process host rejects if its child died mid-status (no honest manifest to synthesize);
        // surface it as a workspaceError, never a crash or a fabricated 0-plugin view (§3.6).
        try {
          workspace = await spawned.slot.host.status();
        } catch (thrown) {
          workspaceError = messageOfThrown(thrown);
        }
      } else workspaceError = spawned.message;
    }
    const info = this.daemonInfo();
    return {
      daemonVersion: this.deps.version,
      pid: info.pid,
      isolation,
      engines: info.engines,
      engineRoots: info.engineRoots,
      workspace,
      workspaceError,
      debugTopics: this.deps.debug.topics(),
      sourceStale: this.sourceStale(),
    };
  }

  setDebug(spec: string): void {
    this.deps.debug.configure(spec);
    this.trace('debug reconfigured', () => ({ spec }));
  }

  /** Daemon-process facts for the `daemon status` management verb (spec-daemon-cli) — a pure
   *  read of this process's own state (uptime via the injected clock), no routing/engine warm. */
  daemonInfo(): DaemonInfo {
    return {
      pid: process.pid,
      uptimeMs: this.deps.clock.now() - this.startedAtMs,
      engines: this.engines.size,
      engineRoots: [...this.engines.values()].map((s) => s.root),
    };
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.sweepTimer?.();
    for (const [repoId] of [...this.engines]) await this.evict(repoId, 'shutdown');
  }

  // ── lifecycle ────────────────────────────────────────────────────────────────

  private toRoute(canonRoot: string): RouteOutcome {
    return { ok: true, repoId: canonRoot as RepoId, root: canonRoot };
  }

  /** Apply the §4c gate to a config-current warm slot (`ts-project-check.ts` owns the decision),
   *  translating its verdict into the slot lifecycle: reuse, refuse, or evict-and-respawn. */
  private async reuseSlot(
    repoId: RepoId,
    root: string,
    slot: EngineSlot,
    requireTsProject: () => boolean,
  ): Promise<{ ok: true; slot: EngineSlot } | { ok: false; message: string } | 'respawn'> {
    // The thunk is consulted ONLY for a slot the gate could still refuse — a `verified` one is
    // reused without paying for the answer.
    const verdict = await gateWarmSlot(root, slot, () => requireTsProject());
    if (verdict.action === 'refuse') return { ok: false, message: verdict.message };
    if (verdict.action === 'respawn') {
      await this.evict(repoId, 'workspace became a TS project');
      return 'respawn';
    }
    slot.lastUsedMs = this.deps.clock.now();
    return { ok: true, slot };
  }

  private async getOrSpawn(
    repoId: RepoId,
    root: string,
    /** Whether this request's ops need an inspectable TS workspace (§4c) — a THUNK, because the
     *  answer costs a config load and a warm `verified` slot never needs it. `false` only for a group
     *  of workspace-INDEPENDENT ops (`OpDefinition.workspaceIndependent`) — today `feedback`, which
     *  must reach the daemon precisely where codemaster cannot work. Defaults to the gated
     *  behaviour, so a caller that says nothing (status, the sweeper) is unaffected. */
    requireTsProject: () => boolean = () => true,
  ): Promise<{ ok: true; slot: EngineSlot } | { ok: false; message: string }> {
    // Pre-flight: an agent may be calling into a removed worktree (§9).
    if (!existsSync(root)) {
      await this.evict(repoId, 'root vanished');
      return { ok: false, message: `workspace root no longer exists: ${root}` };
    }
    // config-reload (§3.5: read-path is the guarantee, not the watcher): the warm engine
    // baked its plugin set / config options at spawn. Reuse it only while the config file is
    // byte-identical; on drift evict so the fall-through re-spawns fresh. An `'unknown'` read
    // (a delete racing the resolve) is inconclusive and never evicts.
    const existing = this.engines.get(repoId);
    if (existing !== undefined && !configChanged(existing.configFp, configFingerprint(root))) {
      const reuse = await this.reuseSlot(repoId, root, existing, requireTsProject);
      if (reuse !== 'respawn') return reuse;
    } else if (existing !== undefined) await this.evict(repoId, 'config changed');

    const loaded = loadConfig(root);
    if (!isOk(loaded)) {
      return { ok: false, message: `config: ${loaded.failure.message}` };
    }
    const { config, source } = loaded.data;
    // §4c: refuse a non-TS folder before warming (a config opts in explicitly → trust it). Taken on
    // EVERY spawn, not only a gated one: a workspace-independent op proceeds despite the refusal,
    // but the engine still carries it (an inbox entry filed from an uninspectable root must say so),
    // and the slot records it so a later workspace-needing request is still refused.
    const tsRefusal = await tsProjectRefusal(root, source);
    if (tsRefusal !== undefined && requireTsProject()) return { ok: false, message: tsRefusal };
    const built = await buildWorkspaceHost(
      this.deps,
      {
        repoId,
        root,
        config,
        source,
        ...(tsRefusal !== undefined ? { workspaceUnsupported: tsRefusal } : {}),
      },
      (host) => {
        // A process child died — drop the slot iff it still holds this exact host, so the next
        // request respawns instead of reusing a dead engine.
        const slot = this.engines.get(repoId);
        if (slot !== undefined && slot.host === host) {
          this.engines.delete(repoId);
          this.deps.debug.ns('eviction')('evict', () => ({
            repo: repoId,
            reason: 'engine child exited',
          }));
        }
      },
    );
    if (!built.ok) return { ok: false, message: built.message };

    const slot: EngineSlot = {
      host: built.host,
      root,
      lastUsedMs: this.deps.clock.now(),
      idleEvictionMs: (config.daemon?.idleEvictionMinutes ?? DEFAULT_IDLE_EVICTION_MIN) * 60_000,
      // The hash of the EXACT bytes loadConfig evaluated — airtight against a config write
      // racing this spawn (a post-load re-read could store newer bytes than the engine ran).
      configFp: loaded.data.fingerprint,
      configSource: source,
      tsProject: tsRefusal === undefined ? 'verified' : 'unsupported',
    };
    this.engines.set(repoId, slot);
    this.trace('engine spawned', () => ({ repo: repoId, engines: this.engines.size }));
    await this.enforceGovernor();
    return { ok: true, slot };
  }

  /** The orchestrator's own op defs (the same objects it injects into engines — §2 thin
   *  boundary: defs never cross it), used to project + plan a cross-root sql join.
   *  Resolved against `root`'s config; builtin ops are config-independent, so any active
   *  root's set is the join's authority. */
  private opDefs(root: string): Map<string, AnyOpDefinition> {
    const loaded = loadConfig(root);
    if (!isOk(loaded)) return new Map();
    const ops = this.deps.opsFor?.(loaded.data.config) ?? [];
    return new Map(ops.map((op) => [op.name, op]));
  }

  private resolvedSqlBounds(): SqlBounds {
    return {
      maxTableRows: this.deps.sqlBounds?.maxTableRows ?? DEFAULT_MAX_TABLE_ROWS,
      maxResultRows: this.deps.sqlBounds?.maxResultRows ?? DEFAULT_MAX_RESULT_ROWS,
    };
  }

  private async evict(repoId: RepoId, reason: string): Promise<void> {
    const slot = this.engines.get(repoId);
    if (slot === undefined) return;
    this.engines.delete(repoId);
    this.deps.debug.ns('eviction')('evict', () => ({ repo: repoId, reason }));
    try {
      await slot.host.dispose();
    } catch (thrown) {
      this.trace('dispose failed', () => ({ repo: repoId, error: messageOfThrown(thrown) }));
    }
  }

  /** Engine-count LRU budget — the in-process shadow of the §9 memory governor (RSS
   *  tracking becomes meaningful in `process` mode, where each engine has its own
   *  process to measure and kill). */
  private async enforceGovernor(): Promise<void> {
    const max = this.deps.maxEngines ?? DEFAULT_MAX_ENGINES;
    while (this.engines.size > max) {
      const lru = [...this.engines.entries()].sort((a, b) => a[1].lastUsedMs - b[1].lastUsedMs)[0];
      if (lru === undefined) return;
      await this.evict(lru[0], 'governor: engine budget exceeded');
    }
  }

  private scheduleSweep(seconds: number): void {
    if (this.disposed) return;
    this.sweepTimer = this.deps.clock.schedule(seconds * 1000, () => {
      this.sweep()
        .catch((thrown: unknown) =>
          this.trace('sweep failed', () => ({ error: messageOfThrown(thrown) })),
        )
        .finally(() => this.scheduleSweep(seconds));
    });
  }

  /** Idle-TTL + path-existence sweep (§9). */
  private async sweep(): Promise<void> {
    const now = this.deps.clock.now();
    for (const [repoId, slot] of [...this.engines]) {
      if (!existsSync(slot.root)) {
        await this.evict(repoId, 'path-existence: root vanished');
        continue;
      }
      if (now - slot.lastUsedMs > slot.idleEvictionMs) {
        await this.evict(repoId, 'idle TTL');
      }
    }
  }
}
