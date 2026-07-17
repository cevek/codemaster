// zod boundary for the MCP tools (§11): everything an agent sends is validated fail-fast here.
// `status`/`batch` advertise handwritten JSON Schemas below (stable, no zod-version coupling); the
// per-op tools are GENERATED from each op's argsSchema (op-tools.ts). `opToolSchema` is reused by
// the per-op route to type-validate the reserved request/flag keys a flat call carries.

import { z } from 'zod';
import type { JsonValue } from '../core/json.ts';
import { jsonValueSchema as jsonValue } from '../common/json/value-schema.ts';

const opRequestSchema = z.object({
  name: z.string().min(1),
  args: jsonValue.default({}),
  apply: z.boolean().optional(),
  /** Mutating ops: return only the verdict + a merged per-file `touched` list (counts +
   *  `(removed)` markers), omitting the unified diff. */
  summaryOnly: z.boolean().optional(),
  verbosity: z.enum(['terse', 'normal', 'full']).optional(),
  format: z.enum(['text', 'json']).optional(),
  debug: z.boolean().optional(),
  /** SQL table alias for this request under a sql-carrying batch (§3). */
  as: z.string().optional(),
  /** Per-request workspace root (cross-repo §1) — a sibling repo this request targets.
   *  Resolution: request root > tool root > cwd. */
  root: z.string().optional(),
});

const returnModeSchema = z.enum(['sql', 'all']).optional();

export const opToolSchema = opRequestSchema.extend({
  root: z.string().optional(),
  /** Single-op sugar (§2.6): a read-only SELECT over this op's table, aliased `t`. */
  sql: z.string().optional(),
  return: returnModeSchema,
});

export const statusToolSchema = z.object({
  root: z.string().optional(),
  /** Render dials (spec-agent-surface-ergonomics §1, t-523883). The DEFAULT is TERSE — the per-repo
   *  frame + one-line-per-op catalogue + concepts (the per-op arg schemas are already in the tool
   *  list, §11). `full` dumps every op's schema+notes; `op` renders one op's detail (precedence over
   *  `full`); `brief` is the back-compat alias of the terse default. */
  brief: z.boolean().optional(),
  full: z.boolean().optional(),
  op: z.string().optional(),
});

export const batchToolSchema = z.object({
  requests: z.array(opRequestSchema).min(1),
  root: z.string().optional(),
  /** A single read-only SELECT across the requests' aliased tables (§1). */
  sql: z.string().optional(),
  return: returnModeSchema,
  /** Render flags for the SQL result itself (the per-request `format`/`verbosity` belong
   *  to the producers, not the join output). Used only with `sql`. */
  format: z.enum(['text', 'json']).optional(),
  verbosity: z.enum(['terse', 'normal', 'full']).optional(),
});

/** Handwritten JSON Schemas for the NON-op tools (`status`/`batch`) in tools/list, each with a
 *  minimal valid `exampleCall` — a complete, schema-valid arguments object for that tool. `badArgs`
 *  appends it to a validation error so the message alone is enough to author the corrected call
 *  (§1.2); the anti-drift test parses every `exampleCall` back through the tool's zod schema. The
 *  per-op tools are generated separately (op-tools.ts). `exampleCall` is internal to codemaster —
 *  `tools/list` advertises only the MCP fields (name/description/inputSchema). */
export const TOOL_DESCRIPTORS = [
  {
    name: 'status',
    exampleCall: {},
    description:
      'First contact: active plugins, per-repo op catalogue (names+summaries) + concepts, freshness, debug topics. ' +
      'Terse by default (per-op arg schemas are already in the tool list). Pass op:"<name>" for one op\'s full schema, or full:true for every op\'s schema+notes.',
    inputSchema: {
      type: 'object',
      properties: {
        root: { type: 'string' },
        op: { type: 'string', description: "Render only this one op's full detail on demand" },
        full: {
          type: 'boolean',
          description:
            "Dump every op's full arg schema + notes + examples (the heavyweight catalogue)",
        },
        brief: {
          type: 'boolean',
          description: 'Back-compat alias of the terse default (names + summaries + concepts)',
        },
      },
    },
  },
  {
    name: 'batch',
    exampleCall: { requests: [{ name: 'find_usages', args: { name: 'Button' } }] },
    description:
      'Run many ops in one round-trip; results in order, one consistent freshness view per plugin. ' +
      'Alias requests with `as` and pass top-level sql to anti-join/join/aggregate over their tables ' +
      '(ephemeral in-memory SQLite, producers run uncapped; only the SQL result returns unless return:all).',
    inputSchema: {
      type: 'object',
      properties: {
        requests: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              args: { type: 'object' },
              apply: { type: 'boolean' },
              summaryOnly: { type: 'boolean' },
              verbosity: { type: 'string', enum: ['terse', 'normal', 'full'] },
              format: { type: 'string', enum: ['text', 'json'] },
              as: {
                type: 'string',
                description: 'SQL table alias for this request (default t/t0..tN)',
              },
              root: {
                type: 'string',
                description:
                  'Per-request workspace root — target a sibling repo (request root > tool root > cwd)',
              },
            },
            required: ['name', 'args'],
          },
        },
        sql: {
          type: 'string',
          description: 'A single read-only SELECT across the aliased request tables',
        },
        return: {
          type: 'string',
          enum: ['sql', 'all'],
          description:
            "With sql: 'sql' (default) returns only the SQL result, 'all' adds each op result",
        },
        format: {
          type: 'string',
          enum: ['text', 'json'],
          description: 'Render format for the SQL result (per-request format is for producers)',
        },
        verbosity: { type: 'string', enum: ['terse', 'normal', 'full'] },
        root: { type: 'string' },
      },
      required: ['requests'],
    },
  },
] as const;

/** The minimal valid arguments object for a tool, used to make a `bad args` error
 *  self-correcting (§1.2). `undefined` only for an unknown tool name. */
export function exampleCallFor(tool: string): JsonValue | undefined {
  return TOOL_DESCRIPTORS.find((d) => d.name === tool)?.exampleCall;
}

export const SERVER_INSTRUCTIONS = `codemaster is a stateful codebase inspector for TS/React repos: a warm TypeScript LanguageService + domain plugins answer structural/semantic queries with proof spans (file:line + verbatim text).
Use it INSTEAD of grep/file-reading for: symbol search, find-usages (catches aliased imports/JSX), definitions, type expansion, SCSS class usage. Each op is its own tool (find_usages, rename_symbol, …) — the tool list IS the catalogue; flags (apply, verbosity, format, root) are top-level params on each op tool. Call the 'status' tool for the per-repo deep dive (per-op notes + shared concepts + freshness); an op tool whose plugin is inactive for the repo returns an honest 'plugin not active'.
Honesty contract: results carry explicit freshness, confidence (certain/partial/dynamic/unresolved) and truncation; a FAIL means codemaster could not do it — fall back to your own tools then. Query directly; do not delegate codemaster lookups to file-reading subagents.
Output is terse by default (spans as file:line:col). verbosity:'full' returns verbatim proof text — use it for one symbol, not for lists. Oversized answers are explicitly capped with '!! OUTPUT CAPPED' — narrow the query, never assume completeness past the marker.
Relational post-filtering: a batch (or any op call) carrying 'sql' loads each aliased request's rows into an ephemeral in-memory SQLite table and runs ONE read-only SELECT — use it for anti-joins / negations / aggregates over op outputs (e.g. components that render <X> but not under <Form>); producers run uncapped, and a 'partial' table makes NOT IN untrustworthy.
Hit a bug or missing capability? File it in-band with the feedback tool: feedback({kind:'wish', title:'…', detail:'…'}) — it travels with this server and records to a global inbox.
Cross-repo: any op or batch request may carry a top-level 'root' to target a sibling TS repo — one batch can mix repos (results stay in order), and 'status' lists the warm roots.`;
