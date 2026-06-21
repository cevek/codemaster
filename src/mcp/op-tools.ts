// Per-op MCP tool descriptors (§11): ONE tool per op, tool-name = op-name. The capability
// catalogue thus lives permanently in the agent's tool-list (a standing reminder of what
// codemaster can do) and each op's args are a typed, visible schema that structurally kills
// arg-shape mistakes. The token cost of N schemas is the deliberate price of that visibility.
//
// The `inputSchema` is GENERATED from the op's canonical zod `argsSchema` via `z.toJSONSchema`
// — single source of truth = the dispatch gate, so the advertised schema can NEVER drift from
// what actually validates — then enriched with the output-shape flags (apply/verbosity/…). The
// canonical `argsSchema` stays the SOLE validator at dispatch (§7); this module only advertises.

import { z } from 'zod';
import type { JsonValue } from '../core/json.ts';
import type { AnyOpDefinition } from '../ops/registry.ts';
import type { OpRequest } from '../ops/contracts.ts';
import { opToolSchema } from './schema.ts';

/** A JSON-Schema object as advertised in `tools/list` (MCP `Tool.inputSchema`). */
interface JsonSchemaObject {
  type: 'object';
  properties?: Record<string, unknown>;
  required?: readonly string[];
}

export interface McpToolDescriptor {
  name: string;
  description: string;
  inputSchema: JsonSchemaObject;
}

/** Reserved request/flag keys a per-op tool's FLAT `arguments` may carry alongside the op's
 *  own args. Extracted at the facade (NOT validated here — `opToolSchema` does that) before the
 *  remainder becomes the op `args`. The anti-drift test (test/unit/op-tools.test.ts) forbids any
 *  op arg OR intake-alias key (extraction runs BEFORE intake) from colliding with this set, so the
 *  blind extraction can never silently eat a real input (§3) — a future op adding e.g. a `format`
 *  arg/alias fails that test until the collision is resolved. */
export const OP_TOOL_RESERVED_KEYS = [
  'apply',
  'summaryOnly',
  'verbosity',
  'format',
  'debug',
  'as',
  'root',
  'sql',
  'return',
] as const;

type ReservedKey = (typeof OP_TOOL_RESERVED_KEYS)[number];

export interface SplitArgs {
  /** The reserved request/flag values, still untyped — `opToolSchema` validates them next. */
  reserved: Partial<Record<ReservedKey, unknown>>;
  /** The op's own args (everything not a reserved key). */
  rest: Record<string, unknown>;
}

/** A flat per-op call resolved into the dispatch shape: the canonical `OpRequest` (op args + its
 *  flags) plus the request/batch-level route keys, OR a pointed validation message. */
export type PerOpRequest =
  | {
      ok: true;
      request: OpRequest;
      root?: string;
      sql?: string;
      returnMode?: 'sql' | 'all';
    }
  | { ok: false; message: string };

/** Resolve a per-op tool's flat `arguments` into an `OpRequest` (§11): extract the reserved
 *  request/flag keys at the facade and re-use `opToolSchema` to type-validate them; the remainder
 *  is the op's own `args`, validated downstream by the op's argsSchema (the sole gate, §7). This is
 *  routing, NOT a second op-args gate. */
export function buildPerOpRequest(opName: string, rawArgs: unknown): PerOpRequest {
  if (
    rawArgs !== undefined &&
    (typeof rawArgs !== 'object' || rawArgs === null || Array.isArray(rawArgs))
  ) {
    return { ok: false, message: 'arguments must be an object' };
  }
  const { reserved, rest } = splitReserved((rawArgs ?? {}) as Record<string, unknown>);
  const parsed = opToolSchema.safeParse({ name: opName, args: rest, ...reserved });
  if (!parsed.success) return { ok: false, message: parsed.error.message };
  const { root, sql, return: returnMode, ...request } = parsed.data;
  return {
    ok: true,
    request: request as OpRequest,
    ...(root !== undefined ? { root } : {}),
    ...(sql !== undefined ? { sql } : {}),
    ...(returnMode !== undefined ? { returnMode } : {}),
  };
}

/** Split a per-op tool's flat `arguments` into the reserved request/flag keys and the op's own
 *  args. Blind by key-name — safe because the anti-drift test guarantees no op arg shares a
 *  reserved name (the facade-blind-extract decision: the test IS the guarantee, §3). */
export function splitReserved(args: Record<string, unknown>): SplitArgs {
  const reservedSet: ReadonlySet<string> = new Set(OP_TOOL_RESERVED_KEYS);
  const reserved: Partial<Record<ReservedKey, unknown>> = {};
  const rest: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) {
    if (reservedSet.has(k)) reserved[k as ReservedKey] = v;
    else rest[k] = v;
  }
  return { reserved, rest };
}

/** The output-shape flags advertised on a per-op tool, gated to applicability: every op gets the
 *  density/format/debug/root knobs; mutating ops add apply/summaryOnly; table-bearing ops add the
 *  single-op sql sugar. Advertising sql only where there's a table is capability-honesty (§3.6). */
function flagProperties(op: AnyOpDefinition): Record<string, unknown> {
  const props: Record<string, unknown> = {
    verbosity: { type: 'string', enum: ['terse', 'normal', 'full'], description: 'Output density' },
    format: {
      type: 'string',
      enum: ['text', 'json'],
      description: 'Output mode (json for machine composition)',
    },
    debug: { type: 'boolean', description: 'Inline per-call debug trace' },
    root: { type: 'string', description: 'Target a sibling repo (default: cwd repo)' },
  };
  if (op.mutating) {
    props['apply'] = {
      type: 'boolean',
      description: 'Actually write the edit (default: dry-run preview)',
    };
    props['summaryOnly'] = {
      type: 'boolean',
      description: 'Verdict + merged per-file touched list, omit the unified diff',
    };
  }
  if (op.table !== undefined) {
    props['sql'] = {
      type: 'string',
      description:
        "Read-only SELECT over this op's table (aliased `t`); only the SQL result returns",
    };
    props['return'] = {
      type: 'string',
      enum: ['sql', 'all'],
      description: "With sql: 'sql' (default) returns only the SELECT, 'all' adds the op result",
    };
  }
  return props;
}

/** Build the advertised `inputSchema`: the op's canonical arg shape (from zod) plus the flags.
 *  `z.toJSONSchema` is wrapped so an unrepresentable/cyclic schema degrades to flags-only rather
 *  than crashing the facade (§3 never-crash) — the canonical gate still validates either way. */
function toInputSchema(op: AnyOpDefinition): JsonSchemaObject {
  let gen: unknown;
  try {
    gen = z.toJSONSchema(op.argsSchema, { unrepresentable: 'any', io: 'input' });
  } catch {
    gen = undefined;
  }
  const g = gen !== null && typeof gen === 'object' ? (gen as Record<string, unknown>) : {};
  const genProps =
    g['properties'] !== null && typeof g['properties'] === 'object'
      ? (g['properties'] as Record<string, unknown>)
      : {};
  const required = Array.isArray(g['required']) ? (g['required'] as string[]) : undefined;
  return {
    type: 'object',
    properties: { ...genProps, ...flagProperties(op) },
    ...(required !== undefined ? { required } : {}),
  };
}

/** The per-op tool description: summary + capability tags (mutating / required plugins) + the
 *  compact `argsHint` (which carries what JSON-Schema can't — the `one-of` target shape, enum
 *  semantics, defaults). Per-op `notes` stay in `status {op:"<name>"}` to bound the token tax. */
function description(op: AnyOpDefinition): string {
  const tags: string[] = [];
  if (op.mutating) tags.push('mutating: dry-run unless apply:true');
  if (op.requires.length > 0) tags.push(`needs: ${op.requires.join(',')}`);
  const tagStr = tags.length > 0 ? ` [${tags.join('; ')}]` : '';
  return `${op.summary}${tagStr} · args: ${op.argsHint}`;
}

export function buildOpToolDescriptor(op: AnyOpDefinition): McpToolDescriptor {
  return { name: op.name, description: description(op), inputSchema: toInputSchema(op) };
}

export function buildOpToolDescriptors(ops: readonly AnyOpDefinition[]): McpToolDescriptor[] {
  return ops.map(buildOpToolDescriptor);
}

/** The minimal valid FLAT arguments for an op tool (its canonical example), used to make a
 *  bad-args error self-correcting (§1.2). `undefined` when the op ships no example. */
export function opToolExample(op: AnyOpDefinition): JsonValue | undefined {
  if (op.example === undefined) return undefined;
  const args = op.example.args as Record<string, JsonValue>;
  return { ...args, ...(op.example.flags ?? {}) };
}
