// The workspace engine — the whole machine for one workspace (§2): all plugins (topo
// init / reverse dispose, dep-scoped registries), the ops that compose them, the
// read-time freshness guard at every batch entry, and request serialization (§8: the
// engine is single-threaded per workspace; the TS LS is synchronous and non-reentrant).
// Transport-agnostic: a `ProjectHost` calls `request()` — in-process directly,
// process-isolated over IPC — and engine code never knows which.

import type { RepoId, RepoRelPath } from '../core/brands.ts';
import type { Plugin, PluginRegistry } from '../core/plugin.ts';
import type { FreshnessNote } from '../core/result.ts';
import type { BatchOptions, OpRequest, OpResult } from '../ops/contracts.ts';
import type { AnyOpDefinition } from '../ops/registry.ts';
import type { Clock } from '../common/async/clock.ts';
import { DEFAULT_MAX_RESULT_ROWS, DEFAULT_MAX_TABLE_ROWS } from '../support/sql/runner.ts';
import { createSqliteRunner } from '../support/sql/better-sqlite3.ts';
import { createJsScanner, type TextScanner } from '../support/text-search/scan.ts';
import { runSqlBatch, type SqlBounds } from './sql-batch.ts';
import { unknownOpMessage } from './dispatch-errors.ts';
import { createPluginRegistry } from '../common/plugin-registry/create.ts';
import { scopeRegistry } from '../common/plugin-registry/scope.ts';
import { messageOfThrown } from '../common/result/construct.ts';
import {
  buildDaemonInfo,
  buildFreshnessNote,
  extractFlags,
  withBatchFreshness,
} from './request-helpers.ts';
import { buildWorkspaceStatus } from './workspace-status.ts';
import type { DebugSystemHandle } from '../support/debug/system.ts';
import type { Watcher, WatcherHandle } from '../support/watch/seam.ts';
import { brandGitPath } from '../support/fs/canonicalize.ts';
import { createFreshnessGuard, type FreshnessMode } from './freshness.ts';
import type { GitRunner } from '../support/git/run.ts';
import type { WorkspaceStatusView } from '../format/render/render-status.ts';

export interface EngineDeps {
  repoId: RepoId;
  /** Canonical workspace root (from `canonicalizeRoot`). */
  root: string;
  configSource: string | undefined;
  /** Codemaster version, surfaced to the `feedback` op's auto-context. */
  version: string;
  /** State base (`~/.codemaster` by default; a temp dir under test) — where the
   *  `feedback` inbox lives. The same seam the per-repo debug log uses. */
  stateDir: string;
  plugins: readonly Plugin[];
  ops: readonly AnyOpDefinition[];
  clock: Clock;
  debug: DebugSystemHandle;
  watcher: Watcher;
  /** Row bounds for sql-mode (§2.3/§2.4). Test seam — lowered to avoid 100k-row
   *  fixtures (spec §7.3/§7.4). Defaults: 100_000 / 1_000. */
  sqlBounds?: Partial<SqlBounds>;
  /** SQL evaluator factory (§4). Test seam; defaults to the lazy better-sqlite3 impl. */
  createSqlRunner?: () => ReturnType<typeof createSqliteRunner>;
  /** Text-scanner factory for `find_usages text:true` (§ text-overlay). Test seam;
   *  defaults to the pure-JS scanner. */
  createTextScanner?: () => TextScanner;
  /** Git runner for the freshness path (§3.6). Test seam; defaults to the real `runGit`.
   *  A faulting runner proves the read-time backstop degrades honestly, never crashes. */
  gitRunner?: GitRunner;
}

export interface WorkspaceEngine {
  readonly repoId: RepoId;
  readonly root: string;
  request(reqs: readonly OpRequest[], batch?: BatchOptions): Promise<readonly OpResult[]>;
  /** Cross-root sql (§2): produce these requests' results as sql-producers (uncapped, one
   *  freshness capture), no SELECT — the orchestrator joins across engines. */
  produceSql(
    reqs: readonly OpRequest[],
  ): Promise<{ results: readonly OpResult[]; freshness: FreshnessNote | undefined }>;
  status(): Promise<WorkspaceStatusView>;
  dispose(): Promise<void>;
}

export async function createEngine(
  deps: EngineDeps,
): Promise<{ ok: true; engine: WorkspaceEngine } | { ok: false; message: string }> {
  const built = createPluginRegistry(deps.plugins);
  if (!built.ok) return { ok: false, message: built.message };
  const { registry, order } = built;

  const trace = deps.debug.ns('repo');
  for (const plugin of order) {
    try {
      await plugin.init(scopeRegistry(registry, plugin.id, plugin.deps));
    } catch (thrown) {
      return {
        ok: false,
        message: `plugin '${plugin.id}' failed to init: ${messageOfThrown(thrown)}`,
      };
    }
  }
  trace('engine up', () => ({ repo: deps.repoId, plugins: order.map((p) => p.id).join(',') }));

  return { ok: true, engine: new Engine(deps, registry, order) };
}

class Engine implements WorkspaceEngine {
  readonly repoId: RepoId;
  readonly root: string;
  private readonly deps: EngineDeps;
  private readonly registry: PluginRegistry;
  private readonly order: readonly Plugin[];
  private readonly guard;
  private readonly opsByName: Map<string, AnyOpDefinition>;
  private readonly watcherHandle: WatcherHandle | undefined;
  private watcherState: 'active' | 'off' | { degraded: string } = 'off';
  private freshnessMode: FreshnessMode = 'git';
  private cleanAtCommit: string | undefined;
  private readonly sqlBounds: SqlBounds;
  private readonly createSqlRunner: () => ReturnType<typeof createSqliteRunner>;
  private readonly textScanner: TextScanner;
  /** Single-flight queue: one workspace serializes its own requests (§8). */
  private queue: Promise<unknown> = Promise.resolve();
  private disposed = false;

  constructor(deps: EngineDeps, registry: PluginRegistry, order: readonly Plugin[]) {
    this.deps = deps;
    this.repoId = deps.repoId;
    this.root = deps.root;
    this.registry = registry;
    this.order = order;
    this.guard = createFreshnessGuard(deps.root, deps.clock, deps.debug, deps.gitRunner);
    this.opsByName = new Map(deps.ops.map((op) => [op.name, op]));
    this.sqlBounds = {
      maxTableRows: deps.sqlBounds?.maxTableRows ?? DEFAULT_MAX_TABLE_ROWS,
      maxResultRows: deps.sqlBounds?.maxResultRows ?? DEFAULT_MAX_RESULT_ROWS,
    };
    this.createSqlRunner = deps.createSqlRunner ?? createSqliteRunner;
    this.textScanner = deps.createTextScanner?.() ?? createJsScanner();

    const watcherTrace = deps.debug.ns('watcher');
    this.watcherHandle = deps.watcher.watch(deps.root, {
      onChanged: (paths) => {
        watcherTrace('changed', () => ({ n: paths.length }));
        this.enqueue(() => this.reindexAll(paths.map((p) => this.toRepoRel(p)))).catch(() => {
          // reindexAll reports through debug; the read-time guard self-corrects.
        });
      },
      onDegraded: (reason) => {
        this.watcherState = { degraded: reason };
        watcherTrace('degraded', () => ({ reason }));
      },
    });
    this.watcherState = this.watcherHandle === undefined ? 'off' : 'active';
  }

  request(reqs: readonly OpRequest[], batch?: BatchOptions): Promise<readonly OpResult[]> {
    return this.enqueue(() => this.runBatch(reqs, batch));
  }

  status(): Promise<WorkspaceStatusView> {
    return this.enqueue(async () => {
      await this.refresh();
      return this.buildStatus();
    });
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    await this.watcherHandle?.close().catch(() => undefined);
    // Reverse-topological order; dispose must be idempotent (core/plugin.ts).
    for (const plugin of [...this.order].reverse()) {
      try {
        await plugin.dispose();
      } catch (thrown) {
        this.deps.debug.ns('repo')('dispose failed', () => ({
          plugin: plugin.id,
          error: messageOfThrown(thrown),
        }));
      }
    }
    this.deps.debug.removeRoutedSink(this.repoId);
  }

  // ── internals ────────────────────────────────────────────────────────────────

  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.then(work, work);
    this.queue = next.catch(() => undefined);
    return next;
  }

  /** §3.5: verify freshness on read; on drift the affected plugins reindex. */
  private async refresh(): Promise<FreshnessNote | undefined> {
    const drift = await this.guard.check();
    this.freshnessMode = drift.mode;
    this.cleanAtCommit = drift.cleanAtCommit;
    // Files the read-time backstop caught drifted and resolved before answering (§1.3).
    const reindexed = drift.changed.length;
    if (reindexed > 0) await this.reindexAll(drift.changed);
    return buildFreshnessNote(this.order, reindexed, this.cleanAtCommit, drift.failure);
  }

  private async reindexAll(changed: readonly RepoRelPath[]): Promise<void> {
    for (const plugin of this.order) {
      try {
        await plugin.reindex(changed);
      } catch (thrown) {
        // The plugin keeps its pending() honest; the failure is traced, the next
        // refresh() will surface remaining staleness as a FreshnessNote.
        this.deps.debug.ns(`plugin:${plugin.id}`)('reindex failed', () => ({
          error: messageOfThrown(thrown),
        }));
      }
    }
  }

  private async runBatch(
    reqs: readonly OpRequest[],
    batch: BatchOptions | undefined,
  ): Promise<readonly OpResult[]> {
    // Freshness captured once at batch entry: the whole batch sees one consistent
    // per-plugin view (§11).
    const batchFreshness = await this.refresh();
    if (batch?.sql !== undefined) return this.runSql(reqs, batch.sql, batch.return, batchFreshness);
    const results: OpResult[] = [];
    for (const req of reqs) {
      results.push(await this.runOne(req, batchFreshness));
    }
    return results;
  }

  /** sql-mode (§5): producers run uncapped, one read-only SELECT joins their tables, only
   *  the SQL result returns (unless `return: 'all'`). The driver lives in sql-batch.ts to
   *  keep this file small and `support/sql/` free of op/MCP knowledge. */
  private runSql(
    reqs: readonly OpRequest[],
    sql: string,
    returnMode: 'sql' | 'all' | undefined,
    batchFreshness: FreshnessNote | undefined,
  ): Promise<readonly OpResult[]> {
    return runSqlBatch({
      reqs,
      sql,
      returnMode: returnMode ?? 'sql',
      opFor: (req) => this.opsByName.get(req.name),
      hasPlugin: (_req, id) => this.registry.has(id),
      bounds: this.sqlBounds,
      createRunner: this.createSqlRunner,
      runProducer: (req) =>
        this.runOne(req, batchFreshness, { tableRowBound: this.sqlBounds.maxTableRows }),
      freshness: batchFreshness,
    });
  }

  /** Cross-root sql (§2): run these requests as sql-producers (uncapped via
   *  `tableRowBound`, freshness captured ONCE at entry) and return their raw results — no
   *  SELECT. The orchestrator collects producers from several engines and runs the join
   *  itself. Serialized through the queue like any request (§8). */
  produceSql(
    reqs: readonly OpRequest[],
  ): Promise<{ results: readonly OpResult[]; freshness: FreshnessNote | undefined }> {
    return this.enqueue(async () => {
      const freshness = await this.refresh();
      const results: OpResult[] = [];
      for (const req of reqs) {
        results.push(
          await this.runOne(req, freshness, { tableRowBound: this.sqlBounds.maxTableRows }),
        );
      }
      return { results, freshness };
    });
  }

  private async runOne(
    req: OpRequest,
    batchFreshness: FreshnessNote | undefined,
    opts?: { tableRowBound?: number },
  ): Promise<OpResult> {
    const op = this.opsByName.get(req.name);
    if (op === undefined) {
      return {
        name: req.name,
        error: { kind: 'unknown_op', message: unknownOpMessage(req.name, this.opsByName) },
      };
    }
    const missing = op.requires.filter((id) => !this.registry.has(id));
    if (missing.length > 0) {
      return {
        name: req.name,
        error: {
          kind: 'unavailable',
          message: `op '${req.name}' needs plugin(s) [${missing.join(', ')}] which are not active in this workspace`,
        },
      };
    }
    const parsed = op.argsSchema.safeParse(req.args);
    if (!parsed.success) {
      const issues = parsed.error.issues
        .map((i) => `${i.path.join('.') || '<args>'}: ${i.message}`)
        .join('; ');
      return {
        name: req.name,
        error: { kind: 'bad_args', message: `${issues} — expected ${op.argsHint}` },
      };
    }

    const opTrace = this.deps.debug.ns(`op:${req.name}`);
    const started = this.deps.clock.now();
    try {
      const result = await this.deps.debug.runWithRequest(
        { capture: req.debug === true, route: this.repoId },
        async () => {
          opTrace('start', () => ({ args: req.args }));
          const r = await op.run(
            {
              plugins: this.registry,
              flags: extractFlags(req),
              daemon: buildDaemonInfo(this.deps, this.order, [...this.opsByName.keys()]),
              textScanner: this.textScanner,
              ...(opts?.tableRowBound !== undefined ? { tableRowBound: opts.tableRowBound } : {}),
            },
            parsed.data,
          );
          opTrace('done', () => ({ ok: r.ok, ms: this.deps.clock.now() - started }));
          const captured = this.deps.debug.takeCapture();
          return captured.length > 0 ? { ...r, debug: captured } : r;
        },
      );
      return { name: req.name, result: withBatchFreshness(result, batchFreshness) };
    } catch (thrown) {
      // An op implementation threw something unwrapped — a codemaster bug, reported
      // as such (§3.6): structured, honest, daemon stays up.
      return {
        name: req.name,
        error: {
          kind: 'op_threw',
          message: `op '${req.name}' threw: ${messageOfThrown(thrown)} (codemaster bug — please report)`,
        },
      };
    }
  }

  private buildStatus(): WorkspaceStatusView {
    return buildWorkspaceStatus({
      repoId: this.repoId,
      root: this.root,
      configSource: this.deps.configSource,
      freshnessMode: this.freshnessMode,
      watcher: this.watcherState,
      plugins: this.order,
      registry: this.registry,
      ops: [...this.opsByName.values()],
    });
  }

  private toRepoRel(absPath: string): RepoRelPath {
    const posix = absPath.split('\\').join('/');
    const prefix = `${this.root}/`;
    return brandGitPath(posix.startsWith(prefix) ? posix.slice(prefix.length) : posix);
  }
}
