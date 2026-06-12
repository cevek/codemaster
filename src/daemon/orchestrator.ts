// The orchestrator (§2, §9): one front door, many workspaces. Holds NO project data —
// a `repoId → host` registry, routing (cwd/root → workspace), lifecycle (lazy
// spin-up, idle-TTL eviction, path-existence sweeper, engine-count governor), and the
// debug surface. It only routes; heavy work lives in the engines.

import { existsSync } from 'node:fs';
import * as path from 'node:path';
import type { RepoId } from '../core/brands.ts';
import type { Plugin } from '../core/plugin.ts';
import type { BatchOptions, OpRequest, OpResult } from '../ops/contracts.ts';
import type { AnyOpDefinition } from '../ops/registry.ts';
import type { Clock, CancelTimer } from '../common/async/clock.ts';
import { messageOfThrown } from '../common/result/construct.ts';
import { isOk } from '../common/result/narrow.ts';
import { fnv1a64Hex } from '../common/hash/fnv.ts';
import type { DebugSystemHandle } from '../support/debug/system.ts';
import type { Watcher } from '../support/watch/seam.ts';
import { canonicalizeRoot } from '../support/fs/canonicalize.ts';
import { gitRepoRoot } from '../support/git/repo-root.ts';
import { loadConfig } from '../support/config-load/load.ts';
import { createRotatingFileSink } from '../support/debug/file-sink.ts';
import type { CodemasterConfig } from '../config/config.ts';
import { createEngine, type WorkspaceEngine } from './engine.ts';
import type { SqlBounds } from './sql-batch.ts';
import type { createSqliteRunner } from '../support/sql/better-sqlite3.ts';
import { createInProcessHost } from './in-process-host.ts';
import type { ProjectHost } from './host.ts';
import type { StatusView, WorkspaceStatusView } from '../format/render/render-status.ts';

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
}

export type RouteOutcome =
  | { ok: true; repoId: RepoId; root: string }
  | { ok: false; message: string };

interface EngineSlot {
  host: ProjectHost;
  root: string;
  lastUsedMs: number;
  idleEvictionMs: number;
}

const DEFAULT_IDLE_EVICTION_MIN = 30;
const DEFAULT_SWEEP_SECONDS = 60;
const DEFAULT_MAX_ENGINES = 8;

export class Orchestrator {
  private readonly deps: OrchestratorDeps;
  private readonly engines = new Map<RepoId, EngineSlot>();
  private readonly trace;
  private sweepTimer: CancelTimer | undefined;
  private disposed = false;
  private readonly startedAtMs: number;

  constructor(deps: OrchestratorDeps) {
    this.deps = deps;
    this.trace = deps.debug.ns('daemon');
    this.startedAtMs = deps.clock.now();
    this.scheduleSweep(DEFAULT_SWEEP_SECONDS);
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
    const routed = await this.route(cwd, root);
    if (!routed.ok) return routed;
    const spawned = await this.getOrSpawn(routed.repoId, routed.root);
    if (!spawned.ok) return spawned;
    const results = await spawned.slot.host.request(reqs, batch);
    return { ok: true, results };
  }

  async status(cwd: string, root?: string): Promise<StatusView> {
    let workspace: WorkspaceStatusView | undefined;
    const routed = await this.route(cwd, root);
    if (routed.ok) {
      const spawned = await this.getOrSpawn(routed.repoId, routed.root);
      if (spawned.ok) {
        workspace = await statusOf(spawned.slot.host);
      } else {
        this.trace('status spawn failed', () => ({ error: spawned.message }));
      }
    }
    return {
      daemonVersion: this.deps.version,
      pid: process.pid,
      isolation: 'in-process',
      engines: this.engines.size,
      workspace,
      debugTopics: this.deps.debug.topics(),
      guidance: GUIDANCE,
    };
  }

  setDebug(spec: string): void {
    this.deps.debug.configure(spec);
    this.trace('debug reconfigured', () => ({ spec }));
  }

  get uptimeMs(): number {
    return this.deps.clock.now() - this.startedAtMs;
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

  private async getOrSpawn(
    repoId: RepoId,
    root: string,
  ): Promise<{ ok: true; slot: EngineSlot } | { ok: false; message: string }> {
    // Pre-flight: an agent may be calling into a removed worktree (§9).
    if (!existsSync(root)) {
      await this.evict(repoId, 'root vanished');
      return { ok: false, message: `workspace root no longer exists: ${root}` };
    }
    const existing = this.engines.get(repoId);
    if (existing !== undefined) {
      existing.lastUsedMs = this.deps.clock.now();
      return { ok: true, slot: existing };
    }

    const loaded = loadConfig(root);
    if (!isOk(loaded)) {
      return { ok: false, message: `config: ${loaded.failure.message}` };
    }
    const { config, source } = loaded.data;
    if (config.daemon?.isolation === 'process') {
      return {
        ok: false,
        message:
          "daemon.isolation 'process' is not implemented yet — remove it (or set 'in-process') in codemaster.config",
      };
    }
    if (config.debug?.namespaces !== undefined && config.debug.namespaces.length > 0) {
      this.deps.debug.configure(config.debug.namespaces.join(','));
    }

    // Per-repo debug log (§13): ~/.codemaster/<repoKey>/debug.log, routed by repoId.
    const stateDir = this.deps.stateDir ?? path.join(homeDir(), '.codemaster');
    const repoKey = `${path.basename(root)}-${fnv1a64Hex(repoId).slice(0, 8)}`;
    const logMaxBytes =
      config.debug?.logMaxMB !== undefined ? config.debug.logMaxMB * 1024 * 1024 : undefined;
    this.deps.debug.addRoutedSink(
      repoId,
      createRotatingFileSink(path.join(stateDir, repoKey, 'debug.log'), logMaxBytes),
    );

    const created = await createEngine({
      repoId,
      root,
      configSource: source,
      version: this.deps.version,
      stateDir,
      plugins: this.deps.pluginsFor?.(config, root) ?? [],
      ops: this.deps.opsFor?.(config) ?? [],
      clock: this.deps.clock,
      debug: this.deps.debug,
      watcher: this.deps.watcher,
      ...(this.deps.sqlBounds !== undefined ? { sqlBounds: this.deps.sqlBounds } : {}),
      ...(this.deps.createSqlRunner !== undefined
        ? { createSqlRunner: this.deps.createSqlRunner }
        : {}),
    });
    if (!created.ok) return { ok: false, message: created.message };

    const slot: EngineSlot = {
      host: createInProcessHost(created.engine),
      root,
      lastUsedMs: this.deps.clock.now(),
      idleEvictionMs: (config.daemon?.idleEvictionMinutes ?? DEFAULT_IDLE_EVICTION_MIN) * 60_000,
    };
    this.engines.set(repoId, slot);
    this.trace('engine spawned', () => ({ repo: repoId, engines: this.engines.size }));
    await this.enforceGovernor();
    return { ok: true, slot };
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

const GUIDANCE = [
  'Query codemaster directly for structural/semantic answers instead of grepping or delegating to file-reading subagents.',
  'Call the op tool with {name, args, …} for any catalogued op; batch with {requests: [{name, args, …}], …} to run several in one round-trip. The catalogue above is per-repo.',
  'Results are proof-carrying (file:line + verbatim text) and report freshness/uncertainty explicitly — a FAIL or partial answer means fall back to your own tools.',
  "Hit a bug or missing capability? File it in-band: op({name:'feedback', args:{kind:'wish', title:'…', detail:'…'}}).",
] as const;

type HostWithEngine = ProjectHost & { engine?: WorkspaceEngine };

async function statusOf(host: ProjectHost): Promise<WorkspaceStatusView | undefined> {
  // In-process hosts expose the engine directly; a process-isolated host will answer
  // status over its IPC channel instead.
  const withEngine = host as HostWithEngine;
  if (withEngine.engine !== undefined) return withEngine.engine.status();
  return undefined;
}

function homeDir(): string {
  return process.env['HOME'] ?? process.env['USERPROFILE'] ?? '/tmp';
}
