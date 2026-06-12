// zod boundary for the MCP tools (§11): everything an agent sends is validated
// fail-fast here. The JSON Schemas advertised in tools/list are handwritten below —
// stable across SDK versions, no zod-version coupling.

import { z } from 'zod';
import type { JsonValue } from '../core/json.ts';

const jsonValue: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(jsonValue),
    z.record(z.string(), jsonValue),
  ]),
);

const opRequestSchema = z.object({
  name: z.string().min(1),
  args: jsonValue.default({}),
  apply: z.boolean().optional(),
  verbosity: z.enum(['terse', 'normal', 'full']).optional(),
  fields: z.array(z.string()).optional(),
  format: z.enum(['text', 'json']).optional(),
  debug: z.boolean().optional(),
  /** SQL table alias for this request under a sql-carrying batch (§3). */
  as: z.string().optional(),
});

const returnModeSchema = z.enum(['sql', 'all']).optional();

export const opToolSchema = opRequestSchema.extend({
  root: z.string().optional(),
  /** Single-op sugar (§2.6): a read-only SELECT over this op's table, aliased `t`. */
  sql: z.string().optional(),
  return: returnModeSchema,
});

export const statusToolSchema = z.object({ root: z.string().optional() });

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

/** Handwritten JSON Schemas for tools/list, each with a minimal valid `exampleCall` —
 *  a complete, schema-valid arguments object for that tool. `badArgs` appends it to a
 *  validation error so the message alone is enough to author the corrected call (§1.2);
 *  the anti-drift test parses every `exampleCall` back through the tool's zod schema.
 *  `exampleCall` is internal to codemaster — `tools/list` advertises only the MCP fields
 *  (name/description/inputSchema). */
export const TOOL_DESCRIPTORS = [
  {
    name: 'op',
    exampleCall: { name: 'find_usages', args: { name: 'Button' } },
    description:
      'Run one codemaster op against this repo (catalogue + arg schemas: call status first). ' +
      'Results are dense and proof-carrying (file:line + verbatim spans). ' +
      'Mutating ops dry-run unless apply:true. ' +
      "Pass sql to post-filter the op's table (aliased `t`) with one read-only SELECT.",
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Op name from the status catalogue' },
        args: { type: 'object', description: 'Op-specific args (schema in status)' },
        apply: { type: 'boolean', description: 'Mutating ops: actually write (default dry-run)' },
        verbosity: { type: 'string', enum: ['terse', 'normal', 'full'] },
        format: { type: 'string', enum: ['text', 'json'] },
        debug: { type: 'boolean', description: 'Inline per-call debug trace' },
        sql: {
          type: 'string',
          description:
            "Read-only SELECT over this op's table (aliased `t`); only the SQL result returns",
        },
        return: {
          type: 'string',
          enum: ['sql', 'all'],
          description:
            "With sql: 'sql' (default) returns only the SQL result, 'all' adds the op result",
        },
        root: { type: 'string', description: 'Workspace root override (default: cwd repo)' },
      },
      required: ['name', 'args'],
    },
  },
  {
    name: 'status',
    exampleCall: {},
    description:
      'First contact: active plugins, per-repo op catalogue with arg schemas, freshness, debug topics.',
    inputSchema: {
      type: 'object',
      properties: { root: { type: 'string' } },
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
              verbosity: { type: 'string', enum: ['terse', 'normal', 'full'] },
              format: { type: 'string', enum: ['text', 'json'] },
              as: {
                type: 'string',
                description: 'SQL table alias for this request (default t/t0..tN)',
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
Use it INSTEAD of grep/file-reading for: symbol search, find-usages (catches aliased imports/JSX), definitions, type expansion, SCSS class usage. Call the 'status' tool first — it lists the per-repo op catalogue with arg schemas.
Honesty contract: results carry explicit freshness, confidence (certain/partial/dynamic/unresolved) and truncation; a FAIL means codemaster could not do it — fall back to your own tools then. Query directly; do not delegate codemaster lookups to file-reading subagents.
Output is terse by default (spans as file:line:col). verbosity:'full' returns verbatim proof text — use it for one symbol, not for lists. Oversized answers are explicitly capped with '!! OUTPUT CAPPED' — narrow the query, never assume completeness past the marker.
Relational post-filtering: a batch (or op) carrying 'sql' loads each aliased request's rows into an ephemeral in-memory SQLite table and runs ONE read-only SELECT — use it for anti-joins / negations / aggregates over op outputs (e.g. components that render <X> but not under <Form>); producers run uncapped, and a 'partial' table makes NOT IN untrustworthy.`;
