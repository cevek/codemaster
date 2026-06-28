// The sql-mode batch driver (spec §5). Kept out of `engine.ts` (which only detects sql
// and delegates) so the engine stays small and `support/sql/` stays a pure evaluator
// that knows nothing of ops or MCP.
//
// Flow: validate (every request's op has a `table`; aliases unique + valid) → run each
// producer with the row bound threaded in (the engine supplies `runProducer`, which sets
// `OpContext.tableRowBound` = MAX_TABLE_ROWS, so an op caps exactly where the engine
// signals partial) → project rows, enforce `MAX_TABLE_ROWS` → register tables → SELECT →
// dispose → assemble the honesty envelope. A producer that errors or returns `ok:false`
// fails the SELECT, NOT the whole call: running SQL over a missing table would silently
// produce wrong joins, so the SELECT is skipped — but every INDEPENDENT, successful
// producer still returns under `return:'all'`, and the sql record is an honest failure
// naming the failed producers (§11; §3.4 no-silent-drop).

import type { JsonValue } from '../core/json.ts';
import type { Result } from '../core/result.ts';
import { fail, messageOfThrown, ok } from '../common/result/construct.ts';
import type { DispatchError, OpRequest, OpResult } from '../ops/contracts.ts';
import type { AnyOpDefinition, TableSpec } from '../ops/registry.ts';
import type { FreshnessNote } from '../core/result.ts';
import { validateTableName, type SqlRunner } from '../support/sql/runner.ts';

export interface SqlBounds {
  maxTableRows: number;
  maxResultRows: number;
}

export interface SqlBatchCtx {
  reqs: readonly OpRequest[];
  sql: string;
  returnMode: 'sql' | 'all';
  /** Per-request op lookup. Single-root: the engine's catalogue. Cross-root (§2): the
   *  orchestrator's own op defs (it owns the same objects it injects) — `TableSpec.rows`
   *  is pure, so projection runs wherever the def is. */
  opFor: (req: OpRequest) => AnyOpDefinition | undefined;
  /** Per-request plugin check. Cross-root, the producer's owning engine is the authority
   *  (it already validated when it ran), so the orchestrator passes `() => true`. */
  hasPlugin: (req: OpRequest, id: string) => boolean;
  bounds: SqlBounds;
  createRunner: () => Result<SqlRunner>;
  /** Runs one request as a producer (`OpContext.tableRowBound` set, §2.3). Single-root:
   *  the engine's `runOne`. Cross-root: a lookup of rows already produced in the owning
   *  engine. */
  runProducer: (req: OpRequest) => Promise<OpResult>;
  freshness: FreshnessNote | undefined;
}

interface PlanItem {
  req: OpRequest;
  op: AnyOpDefinition;
  table: TableSpec<JsonValue>;
  alias: string;
}

export async function runSqlBatch(ctx: SqlBatchCtx): Promise<readonly OpResult[]> {
  const plan = planAliases(ctx.reqs, ctx.opFor, ctx.hasPlugin);
  if (!plan.ok) return [{ name: 'sql', error: plan.error }];

  const perReq: OpResult[] = [];
  const producers: {
    alias: string;
    table: TableSpec<JsonValue>;
    data: JsonValue;
    /** The producer itself reported an internal cap (`result.truncated`). Its table is
     *  incomplete even when the projected row count sits below `maxTableRows` — without
     *  this, a >MAX_TABLE_ROWS reference set would feed `NOT IN` silently (§2.3). */
    producerTruncated: boolean;
  }[] = [];
  const failed: string[] = [];
  for (const item of plan.items) {
    const produced = await ctx.runProducer(item.req);
    perReq.push(produced);
    // A producer that errors or returns ok:false fails the SELECT — never its INDEPENDENT
    // neighbours. We run them all (they were already going to run; the cost is accepted)
    // and gate only the SELECT, since a join over a missing table would silently lie (§11).
    // The cause is carried INLINE so `return:'sql'` (where per-request results are absent)
    // still tells the agent both who failed and why, no re-run needed.
    if ('error' in produced) {
      failed.push(`'${item.req.name}' (as ${item.alias}) failed: ${produced.error.message}`);
      continue;
    }
    if (!produced.result.ok) {
      failed.push(
        `'${item.req.name}' (as ${item.alias}) failed: ${produced.result.failure.message}`,
      );
      continue;
    }
    producers.push({
      alias: item.alias,
      table: item.table,
      data: produced.result.data,
      producerTruncated: produced.result.truncated !== undefined,
    });
  }

  // SELECT not run when any producer failed — but every successful neighbour still returns
  // under `return:'all'`. The sql record is an honest failure naming the failed producers
  // WITH their causes inline; under `return:'all'` the per-request results carry the full
  // failure too (§3.4, §11).
  const sqlResult: OpResult =
    failed.length > 0
      ? {
          name: 'sql',
          result: fail({
            tool: 'sql',
            message: `SELECT not run — producer(s) ${failed.join('; ')}. Under return:'all' the per-request results above carry each full failure.`,
          }),
        }
      : assemble(producers, ctx);
  return finalize(ctx.returnMode, perReq, sqlResult);
}

function finalize(
  returnMode: 'sql' | 'all',
  perReq: readonly OpResult[],
  sqlResult: OpResult,
): readonly OpResult[] {
  return returnMode === 'all' ? [...perReq, sqlResult] : [sqlResult];
}

/** Project → bound → register → query → dispose, with the §5.5 envelope. Returns an
 *  `OpResult`: a SQL error becomes a pointed `bad_args` listing every table's columns
 *  (§4.6); a native-load failure becomes an honest `ToolFailure`; success carries the
 *  rows plus partial/truncation/notes. */
function assemble(
  producers: ReadonlyArray<{
    alias: string;
    table: TableSpec<JsonValue>;
    data: JsonValue;
    producerTruncated: boolean;
  }>,
  ctx: SqlBatchCtx,
): OpResult {
  const runnerOutcome = ctx.createRunner();
  if (!runnerOutcome.ok) {
    // Native-load / open failure (§4.1) — surface the ToolFailure verbatim, no data.
    return { name: 'sql', result: fail(runnerOutcome.failure) };
  }
  const runner = runnerOutcome.data;

  const boundedTables: string[] = [];
  const notes: string[] = [];
  try {
    for (const p of producers) {
      const allRows = p.table.rows(p.data);
      const capped = allRows.length > ctx.bounds.maxTableRows;
      const rows = capped ? allRows.slice(0, ctx.bounds.maxTableRows) : allRows;
      if (capped || p.producerTruncated) boundedTables.push(p.alias);
      runner.register(p.alias, p.table.columns, rows);
      if (p.table.notes !== undefined) notes.push(...p.table.notes(p.data));
    }

    const queried = runner.query(ctx.sql, ctx.bounds.maxResultRows);
    const data: JsonValue = {
      columns: queried.columns,
      rows: queried.rows,
      ...(boundedTables.length > 0
        ? {
            partial: {
              boundedTables,
              reason: `table(s) hit MAX_TABLE_ROWS=${ctx.bounds.maxTableRows} and were truncated — anti-joins / NOT IN over them are NOT trustworthy`,
            },
          }
        : {}),
      ...(notes.length > 0 ? { notes } : {}),
    };
    const truncated =
      queried.total > queried.rows.length
        ? {
            shown: queried.rows.length,
            total: queried.total,
            hint: 'add a LIMIT or aggregate (COUNT/GROUP BY) — the result was capped',
          }
        : undefined;
    return {
      name: 'sql',
      result: ok(data, {
        ...(ctx.freshness !== undefined ? { freshness: ctx.freshness } : {}),
        ...(truncated !== undefined ? { truncated } : {}),
      }),
    };
  } catch (thrown) {
    // A register failure (hostile alias slipped through, seeding error) is our bug or a
    // tool failure; a query failure is the agent's SQL. Both surface honestly. We can't
    // tell which from the throw, so report as bad_args with the schema (§4.6) — the
    // agent's most likely cause and its only way to see the schema mid-flight.
    const schema = producers
      .map((p) => `${p.alias}(${p.table.columns.map((c) => c.name).join(', ')})`)
      .join('  ·  ');
    return {
      name: 'sql',
      error: {
        kind: 'bad_args',
        message: `SQL failed: ${messageOfThrown(thrown)}. Available tables — ${schema}`,
      },
    };
  } finally {
    runner.dispose();
  }
}

type PlanOutcome = { ok: true; items: PlanItem[] } | { ok: false; error: DispatchError };

/** Validate ops + assign/validate aliases (default `t` for one request, `t0..tN` for
 *  several — §5.1). Any problem fails the whole call with a pointed dispatch error. */
function planAliases(
  reqs: readonly OpRequest[],
  opFor: (req: OpRequest) => AnyOpDefinition | undefined,
  hasPlugin: (req: OpRequest, id: string) => boolean,
): PlanOutcome {
  const items: PlanItem[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < reqs.length; i++) {
    const req = reqs[i];
    if (req === undefined) continue;
    const op = opFor(req);
    if (op === undefined) {
      return dispatchBadArgs(
        `unknown op '${req.name}' in sql batch (see status for the catalogue)`,
      );
    }
    const missing = op.requires.filter((id) => !hasPlugin(req, id));
    if (missing.length > 0) {
      return dispatchBadArgs(
        `op '${req.name}' needs plugin(s) [${missing.join(', ')}] not active in this workspace`,
      );
    }
    if (op.table === undefined) {
      return dispatchBadArgs(
        `op '${req.name}' has no table — it is not list-shaped and cannot be used under sql. Tabular ops: see status (each lists its columns).`,
      );
    }
    const alias = req.as ?? (reqs.length === 1 ? 't' : `t${i}`);
    const aliasError = validateTableName(alias);
    if (aliasError !== undefined) return dispatchBadArgs(aliasError);
    if (seen.has(alias)) {
      return dispatchBadArgs(
        `duplicate table alias '${alias}' — each request's 'as' must be unique`,
      );
    }
    seen.add(alias);
    items.push({ req, op, table: op.table, alias });
  }
  return { ok: true, items };
}

/** A dispatch-level rejection (a `DispatchError`, returned before any op runs) — distinct
 *  from `mcp/server.ts`'s `badArgs`, which produces an agent-facing `CallToolResult` at
 *  the MCP boundary. Different layers, different return shapes; named apart so the two
 *  don't read as one helper. */
function dispatchBadArgs(message: string): { ok: false; error: DispatchError } {
  return { ok: false, error: { kind: 'bad_args', message } };
}
