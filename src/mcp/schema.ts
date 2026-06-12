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
});

export const opToolSchema = opRequestSchema.extend({
  root: z.string().optional(),
});

export const statusToolSchema = z.object({ root: z.string().optional() });

export const batchToolSchema = z.object({
  requests: z.array(opRequestSchema).min(1),
  root: z.string().optional(),
});

/** Handwritten JSON Schemas for tools/list. */
export const TOOL_DESCRIPTORS = [
  {
    name: 'op',
    description:
      'Run one codemaster op against this repo (catalogue + arg schemas: call status first). ' +
      'Results are dense and proof-carrying (file:line + verbatim spans). ' +
      'Mutating ops dry-run unless apply:true.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Op name from the status catalogue' },
        args: { type: 'object', description: 'Op-specific args (schema in status)' },
        apply: { type: 'boolean', description: 'Mutating ops: actually write (default dry-run)' },
        verbosity: { type: 'string', enum: ['terse', 'normal', 'full'] },
        format: { type: 'string', enum: ['text', 'json'] },
        debug: { type: 'boolean', description: 'Inline per-call debug trace' },
        root: { type: 'string', description: 'Workspace root override (default: cwd repo)' },
      },
      required: ['name', 'args'],
    },
  },
  {
    name: 'status',
    description:
      'First contact: active plugins, per-repo op catalogue with arg schemas, freshness, debug topics.',
    inputSchema: {
      type: 'object',
      properties: { root: { type: 'string' } },
    },
  },
  {
    name: 'batch',
    description:
      'Run many ops in one round-trip; results in order, one consistent freshness view per plugin.',
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
            },
            required: ['name', 'args'],
          },
        },
        root: { type: 'string' },
      },
      required: ['requests'],
    },
  },
] as const;

export const SERVER_INSTRUCTIONS = `codemaster is a stateful codebase inspector for TS/React repos: a warm TypeScript LanguageService + domain plugins answer structural/semantic queries with proof spans (file:line + verbatim text).
Use it INSTEAD of grep/file-reading for: symbol search, find-usages (catches aliased imports/JSX), definitions, type expansion, SCSS class usage. Call the 'status' tool first — it lists the per-repo op catalogue with arg schemas.
Honesty contract: results carry explicit freshness, confidence (certain/partial/dynamic/unresolved) and truncation; a FAIL means codemaster could not do it — fall back to your own tools then. Query directly; do not delegate codemaster lookups to file-reading subagents.
Output is terse by default (spans as file:line:col). verbosity:'full' returns verbatim proof text — use it for one symbol, not for lists. Oversized answers are explicitly capped with '!! OUTPUT CAPPED' — narrow the query, never assume completeness past the marker.`;
