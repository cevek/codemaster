// Multi-root dispatch (cross-repo §2): when a batch spans sibling repos, group requests
// by resolved engine, dispatch one sub-batch per engine, and reassemble in original
// request order. Cross-root sql runs the join here at the orchestrator — producers run in
// their owning engines (thin `Result` rows cross the host boundary), the orchestrator
// projects with its own op defs (`TableSpec.rows` is pure) and runs one SELECT. Lives
// outside orchestrator.ts to keep that file at its single responsibility (routing +
// lifecycle) under the line cap.

import type { RepoId } from '../core/brands.ts';
import type { FreshnessNote } from '../core/result.ts';
import type { BatchOptions, OpRequest, OpResult } from '../ops/contracts.ts';
import type { AnyOpDefinition } from '../ops/registry.ts';
import { mergeFreshness } from '../common/result/merge-freshness.ts';
import type { ProjectHost } from './host.ts';
import { runSqlBatch, type SqlBounds } from './sql-batch.ts';
import type { SqlRunner } from '../support/sql/runner.ts';
import type { Result } from '../core/result.ts';

export type RouteOk = { ok: true; repoId: RepoId; root: string };
export type RouteOutcome = RouteOk | { ok: false; message: string };

/** Spawn (or reuse) an engine for a resolved root, returning its host. */
export type SpawnHost = (
  repoId: RepoId,
  root: string,
) => Promise<{ ok: true; host: ProjectHost } | { ok: false; message: string }>;

/** Group request indices by resolved engine, dropping unresolved ones to their error. */
function groupByEngine(
  reqs: readonly OpRequest[],
  routes: readonly RouteOutcome[],
): { groups: Map<RepoId, { root: string; idxs: number[] }>; errors: Map<number, OpResult> } {
  const groups = new Map<RepoId, { root: string; idxs: number[] }>();
  const errors = new Map<number, OpResult>();
  routes.forEach((route, i) => {
    const req = reqs[i];
    if (req === undefined) return;
    if (!route.ok) {
      errors.set(i, { name: req.name, error: { kind: 'bad_args', message: route.message } });
      return;
    }
    const g = groups.get(route.repoId) ?? { root: route.root, idxs: [] };
    g.idxs.push(i);
    groups.set(route.repoId, g);
  });
  return { groups, errors };
}

/** Multi-root, non-sql: one sub-batch per engine (each pins its own batch-entry
 *  freshness), reassembled in original order; an unresolved root → `DispatchError` in its
 *  slot, siblings still run (§2). */
export async function groupedDispatch(
  reqs: readonly OpRequest[],
  routes: readonly RouteOutcome[],
  batch: BatchOptions | undefined,
  spawn: SpawnHost,
): Promise<OpResult[]> {
  const { groups, errors } = groupByEngine(reqs, routes);
  const results: (OpResult | undefined)[] = reqs.map((_, i) => errors.get(i));
  for (const [repoId, g] of groups) {
    const spawned = await spawn(repoId, g.root);
    const groupReqs = g.idxs.flatMap((i) => (reqs[i] !== undefined ? [reqs[i] as OpRequest] : []));
    if (!spawned.ok) {
      for (const i of g.idxs) {
        const req = reqs[i];
        if (req !== undefined) {
          results[i] = { name: req.name, error: { kind: 'unavailable', message: spawned.message } };
        }
      }
      continue;
    }
    const groupResults = await spawned.host.request(groupReqs, batch);
    g.idxs.forEach((i, k) => {
      results[i] = groupResults[k];
    });
  }
  // Every slot must be filled — dropping an undefined one would silently SHRINK the
  // results array and shift every later result off its request index (a positional lie,
  // §3.4). An engine returning fewer results than requests is a codemaster bug; say so
  // in that slot instead of hiding it.
  return results.map(
    (r, i) =>
      r ?? {
        name: reqs[i]?.name ?? 'unknown',
        error: {
          kind: 'op_threw' as const,
          message: 'engine returned no result for this request slot (codemaster bug)',
        },
      },
  );
}

export interface CrossRootSqlDeps {
  spawn: SpawnHost;
  opDefs: (root: string) => Map<string, AnyOpDefinition>;
  bounds: SqlBounds;
  createRunner: () => Result<SqlRunner>;
}

/** Cross-root sql (§2): produce each engine's requests in that engine (one produce-call
 *  per engine → one freshness capture each), then project + join once at the orchestrator
 *  with its own op defs. The sql note is the worst-of freshness across touched engines. */
export async function crossRootSql(
  reqs: readonly OpRequest[],
  routes: readonly RouteOutcome[],
  batch: BatchOptions,
  deps: CrossRootSqlDeps,
): Promise<OpResult[]> {
  const sql = batch.sql;
  if (sql === undefined) return [];
  const unresolved = routes.find((r): r is { ok: false; message: string } => !r.ok);
  if (unresolved !== undefined) {
    // A producer with no engine means a missing table — no honest join (§5.2).
    return [
      {
        name: 'sql',
        error: { kind: 'bad_args', message: `cross-root sql: ${unresolved.message}` },
      },
    ];
  }
  const { groups } = groupByEngine(reqs, routes);
  const produced = new Map<OpRequest, OpResult>();
  const freshness: (FreshnessNote | undefined)[] = [];
  let firstRoot: string | undefined;
  for (const [repoId, g] of groups) {
    firstRoot ??= g.root;
    const spawned = await deps.spawn(repoId, g.root);
    if (!spawned.ok)
      return [{ name: 'sql', error: { kind: 'unavailable', message: spawned.message } }];
    const groupReqs = g.idxs.flatMap((i) => (reqs[i] !== undefined ? [reqs[i] as OpRequest] : []));
    const out = await spawned.host.produceSql(groupReqs);
    out.results.forEach((res, k) => {
      const req = reqs[g.idxs[k] ?? -1];
      if (req !== undefined) produced.set(req, res);
    });
    freshness.push(out.freshness);
  }
  const opDefs =
    firstRoot !== undefined ? deps.opDefs(firstRoot) : new Map<string, AnyOpDefinition>();
  return [
    ...(await runSqlBatch({
      reqs,
      sql,
      returnMode: batch.return ?? 'sql',
      opFor: (req) => opDefs.get(req.name),
      hasPlugin: () => true, // the owning engine already validated when it produced
      bounds: deps.bounds,
      createRunner: deps.createRunner,
      runProducer: (req) =>
        Promise.resolve(
          produced.get(req) ?? {
            name: req.name,
            error: { kind: 'op_threw', message: 'producer not pre-run (codemaster bug)' },
          },
        ),
      freshness: mergeFreshness(freshness),
    })),
  ];
}
