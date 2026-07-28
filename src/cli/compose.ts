// The CLI composition surface (§11): `batch` and `sql` on the one-shot `codemaster` path, so the
// CLI is no longer a REDUCED surface — the two composition features exist on both front doors.
//
// It adds no engine capability and no second validator. The requests are validated by the SAME
// `batchToolSchema` the MCP `batch` tool uses, normalized by the SAME `normalizeBatchArguments`
// (so the flat `{op:…}` envelope dispatches correctly here too, §7), executed through the SAME
// `orchestrator.request(…, BatchOptions)` — which is where `runSqlBatch` runs the producers
// UNCAPPED and merges their `disclosures` into the join's envelope — and rendered by the SAME
// `renderBatch`/`renderResults`. This module composes those; it never assembles an envelope of
// its own, which is exactly how the honesty channels (disclosures / freshness / truncation) reach
// the CLI's stdout without being forwarded by hand.

import type { BatchOptions, OpRequest, OpResult } from '../ops/contracts.ts';
import type { Verbosity } from '../core/result.ts';
import type { OrchestratorApi } from '../daemon/orchestrator-api.ts';
import { batchToolSchema } from '../mcp/schema.ts';
import { normalizeBatchArguments } from '../mcp/op-tools.ts';
import { renderBatch, renderResults } from '../mcp/render-response.ts';
import { flagIssue, flagValue } from './flags.ts';

/** What the CLI writes back: stdout lines (the payload), stderr lines (diagnostics), exit code. */
export interface CliOutcome {
  stdout: readonly string[];
  stderr: readonly string[];
  code: number;
}

/** The value-bearing flags `batch` accepts, for the §3 unread-input check. */
export const BATCH_VALUE_FLAGS = [
  '--sql',
  '--return',
  '--format',
  '--verbosity',
  '--root',
] as const;

export const BATCH_USAGE =
  "usage: codemaster batch '<json>' [--sql '<SELECT>'] [--return sql|all] [--root <dir>] [--format text|json] [--verbosity terse|normal|full]\n" +
  '  <json>: {"requests":[{"name":"<op>","args":{…},"as":"<alias>"},…]} — or just the requests array\n';

/** A parsed compose invocation, ready to dispatch. */
export interface ComposePlan {
  requests: readonly OpRequest[];
  batch: BatchOptions | undefined;
  format: 'text' | 'json' | undefined;
  verbosity: Verbosity | undefined;
  root: string | undefined;
}

export type ComposeParse = { ok: true; plan: ComposePlan } | { ok: false; message: string };

/** Flag values already extracted from argv by the caller (which owns the splice/stray checks). */
export interface ComposeFlags {
  sql?: string | undefined;
  returnMode?: string | undefined;
  format?: string | undefined;
  verbosity?: string | undefined;
  root?: string | undefined;
}

/** Parse the `batch` positional JSON + its flags into a dispatchable plan.
 *
 *  Two accepted spellings of the payload — the MCP `batch` arguments object
 *  (`{requests:[…], sql?, …}`) and a bare requests ARRAY (the common case, and the one that keeps
 *  a shell-quoted call short). The array is wrapped into `{requests}` BEFORE normalization, never
 *  after: `normalizeBatchArguments` only rewrites a `{requests:[…]}` shape, so an unwrapped array
 *  of the flat `{op:…}` form would skip the rewrite and dispatch each request's `name` VALUE as the
 *  op name — the precise misdispatch that normalizer exists to prevent (§7).
 *
 *  A flag and the same key inside the JSON is REJECTED, not silently resolved: picking one would
 *  drop input the caller wrote (§3). */
export function parseComposeArgs(rawJson: string, flags: ComposeFlags): ComposeParse {
  let payload: unknown;
  try {
    payload = JSON.parse(rawJson);
  } catch {
    return { ok: false, message: `batch json is not valid JSON: ${rawJson}` };
  }
  if (Array.isArray(payload)) payload = { requests: payload };
  if (payload === null || typeof payload !== 'object') {
    return {
      ok: false,
      message: 'batch json must be an object {requests:[…]} or a requests array',
    };
  }
  const obj = payload as Record<string, unknown>;
  const conflict = ['sql', 'return', 'format', 'verbosity', 'root'].find(
    (key) => obj[key] !== undefined && flagOf(flags, key) !== undefined,
  );
  if (conflict !== undefined) {
    return {
      ok: false,
      message: `'${conflict}' given BOTH as --${conflict} and inside the json — pass it once (neither is silently preferred)`,
    };
  }
  const merged = {
    ...obj,
    ...(flags.sql !== undefined ? { sql: flags.sql } : {}),
    ...(flags.returnMode !== undefined ? { return: flags.returnMode } : {}),
    ...(flags.format !== undefined ? { format: flags.format } : {}),
    ...(flags.verbosity !== undefined ? { verbosity: flags.verbosity } : {}),
    ...(flags.root !== undefined ? { root: flags.root } : {}),
  };
  const parsed = batchToolSchema.safeParse(normalizeBatchArguments(merged));
  if (!parsed.success) return { ok: false, message: `bad batch args: ${parsed.error.message}` };
  const { requests, sql, return: returnMode, format, verbosity, root } = parsed.data;
  return {
    ok: true,
    plan: {
      requests: requests as OpRequest[],
      batch:
        sql !== undefined
          ? { sql, ...(returnMode !== undefined ? { return: returnMode } : {}) }
          : undefined,
      format,
      verbosity,
      root,
    },
  };
}

/** Parse the whole `batch` argv tail: its value-flags (spliced out), the §3 unread-input check,
 *  the single positional JSON. Lives here rather than in `bin.ts` so the entry point stays a
 *  composition root — and so the surface's flags and its usage line are stated once, together. */
export function parseBatchCommand(
  args: string[],
  root: string | undefined,
): ComposeParse | { ok: false; message: string } {
  // `--sql` is a FLAG rather than a json key by default because a SELECT carries its own quotes;
  // both spellings are accepted, and giving one key twice is rejected, not silently resolved.
  const flags: ComposeFlags = {
    sql: flagValue(args, '--sql'),
    returnMode: flagValue(args, '--return'),
    format: flagValue(args, '--format'),
    verbosity: flagValue(args, '--verbosity'),
    root,
  };
  const issue = flagIssue(args, [...BATCH_VALUE_FLAGS]);
  if (issue !== undefined) return { ok: false, message: issue };
  if (args.length > 1) {
    return { ok: false, message: `unexpected argument(s): ${args.slice(1).join(', ')}` };
  }
  const rawJson = args[0];
  if (rawJson === undefined) return { ok: false, message: 'batch needs its <json> requests' };
  return parseComposeArgs(rawJson, flags);
}

function flagOf(flags: ComposeFlags, key: string): string | undefined {
  switch (key) {
    case 'sql':
      return flags.sql;
    case 'return':
      return flags.returnMode;
    case 'format':
      return flags.format;
    case 'verbosity':
      return flags.verbosity;
    default:
      return flags.root;
  }
}

/** Dispatch a plan and render it exactly as the MCP `batch` tool does (`renderBatch`), so the two
 *  surfaces answer the same call with the same bytes. */
export async function runCompose(
  orchestrator: OrchestratorApi,
  cwd: string,
  plan: ComposePlan,
): Promise<CliOutcome> {
  const outcome = await orchestrator.request(cwd, plan.root, plan.requests, plan.batch);
  if (!outcome.ok) return { stdout: [], stderr: [outcome.message], code: 1 };
  const body = renderBatch(outcome.results, plan.requests, {
    sqlPresent: plan.batch?.sql !== undefined,
    format: plan.format,
    verbosity: plan.verbosity,
  });
  return { stdout: [body], stderr: [], code: exitCode(outcome.results) };
}

/** Dispatch the single-op `--sql` sugar: a batch of one request aliased `t`, rendered through
 *  `renderResults` — byte-parity with the MCP per-op `sql` param. */
export async function runOpSql(
  orchestrator: OrchestratorApi,
  cwd: string,
  root: string | undefined,
  request: OpRequest,
  batch: BatchOptions,
): Promise<CliOutcome> {
  const outcome = await orchestrator.request(cwd, root, [{ ...request, as: 't' }], batch);
  if (!outcome.ok) return { stdout: [], stderr: [outcome.message], code: 1 };
  const body = renderResults(outcome.results, request.format, request.verbosity);
  return { stdout: [body], stderr: [], code: exitCode(outcome.results) };
}

/** Exit code parity with the plain `op` path (t-337633): a DISPATCH rejection (the request never
 *  reached an op) is non-zero, a structured `ok:false` ToolFailure is NOT — that is an honest
 *  answer, and a failed sql producer produces exactly that on the synthetic `sql` record. */
function exitCode(results: readonly OpResult[]): number {
  return results.some((r) => 'error' in r) ? 1 : 0;
}

/** The non-op surfaces an agent reaches for as `codemaster op <x>` (t-141874). `batch` and `status`
 *  are not unknown — they exist, they are just not dispatched through `op`, and answering "unknown
 *  op 'batch'" is true about this route and FALSE about the tool (§3.6). Names the form that works
 *  here; it does not recommend a surface. */
const NON_OP_SURFACES: Readonly<Record<string, string>> = {
  batch:
    "'batch' is not an op — it is a composition surface, dispatched on its own. Here: " +
    "codemaster batch '<json-requests>' [--sql '<SELECT>']; a single op composes with " +
    "codemaster op <name> '<json-args>' --sql '<SELECT>'.",
  status:
    "'status' is not an op — it is the per-repo manifest. Here: codemaster status [--op <name>].",
};

export function nonOpSurfaceMessage(name: string): string | undefined {
  return NON_OP_SURFACES[name];
}
