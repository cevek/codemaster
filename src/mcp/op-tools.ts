// Per-op MCP tool descriptors (§11): ONE tool per op, tool-name = op-name. The capability
// catalogue thus lives permanently in the agent's tool-list (a standing reminder of what
// codemaster can do) and each op's args are a typed, visible schema that structurally kills
// arg-shape mistakes. The token cost of N schemas is the deliberate price of that visibility.
//
// The `inputSchema` is GENERATED from the op's canonical zod `argsSchema` — single source of truth
// = the dispatch gate, so the advertised schema can NEVER drift from what actually validates. The
// generator lives in `ops/tool-schema/input-schema.ts` because `status {op}` advertises the SAME
// object (t-981812). The canonical `argsSchema` stays the SOLE validator at dispatch (§7); this
// module only advertises.

import type { JsonValue } from '../core/json.ts';
import type { AnyOpDefinition } from '../ops/registry.ts';
import type { OpRequest } from '../ops/contracts.ts';
import { buildOpInputSchema, type JsonSchemaObject } from '../ops/tool-schema/input-schema.ts';
import { opToolSchema } from './schema.ts';

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

/** Normalize a batch request ENVELOPE (§7/§11). The canonical envelope is `{name:'<op>', args:{…}}`,
 *  but an agent naturally writes the FLAT per-op form `{op:'find_usages', name:'Plugin', …}` (the
 *  standalone tools take flat args) — where the envelope schema (`z.object`) would silently strip the
 *  unknown `op` key and dispatch the request's `name` VALUE (`'Plugin'`) as the op. So when a request
 *  carries an `op` key we treat it as the flat form: `op` is the op name, reserved keys lift to the
 *  request, and the remainder becomes `args` (unless a lone canonical `args` object is present). A
 *  request WITHOUT `op` is passed through untouched — the canonical `{name,args}` envelope still
 *  validates exactly as before. The op's own arg intake (symbol→name, …) still runs downstream on
 *  `args`; this only fixes the envelope. `transaction` sub-steps do not pass through here (§7). */
export function normalizeBatchEnvelope(raw: unknown): unknown {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return raw;
  const obj = raw as Record<string, unknown>;
  if (!('op' in obj)) return raw;
  const { op, ...restAll } = obj;
  const { reserved, rest } = splitReserved(restAll);
  const restKeys = Object.keys(rest);
  // A lone canonical `args` object (the mixed `{op, args:{…}}` form) is used directly; otherwise the
  // flat top-level keys ARE the args (the natural `{op, name, …}` form). A mixed shape with both an
  // `args` key and stray keys folds everything into `args` and fails the op schema honestly (§3).
  const args =
    restKeys.length === 1 &&
    restKeys[0] === 'args' &&
    rest['args'] !== null &&
    typeof rest['args'] === 'object' &&
    !Array.isArray(rest['args'])
      ? rest['args']
      : rest;
  return { name: op, args, ...reserved };
}

/** Normalize a whole `batch` tool call's raw arguments: rewrite each request's flat `{op,…}`
 *  envelope to canonical `{name,args}` (normalizeBatchEnvelope) BEFORE zod validation, so the natural
 *  flat form dispatches correctly instead of the schema silently stripping `op` (§7/§11). Anything
 *  not shaped `{requests:[…]}` passes through untouched — the schema then reports the real error. */
export function normalizeBatchArguments(raw: unknown): unknown {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return raw;
  const obj = raw as Record<string, unknown>;
  if (!Array.isArray(obj['requests'])) return raw;
  return { ...obj, requests: obj['requests'].map(normalizeBatchEnvelope) };
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

/** A handwritten tool descriptor (status/batch) — MCP fields only, as advertised. */
interface StaticToolDescriptor {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: unknown;
}

/** Advertise the LIVE op catalogue as the `enum` of `batch.requests[].name` (t-568278). Inside a
 *  batch the per-op tools' typed schemas don't apply, so a typo'd op name was a free-form string
 *  that only failed at dispatch — making an N-op batch statically WEAKER than N separate calls,
 *  the opposite of the guidance to prefer one batch. The enum is built from the same `ops` list
 *  that backs the per-op descriptors (never a second, drifting catalogue) and applied to a COPY —
 *  `TOOL_DESCRIPTORS` is a shared `as const` that `exampleCallFor` also reads. A shape that isn't
 *  the expected `{requests:{items:{properties:{name}}}}` is returned untouched rather than
 *  force-patched: advertising a half-built schema would be worse than advertising the plain one. */
export function withBatchOpNames(
  tool: StaticToolDescriptor,
  opNames: readonly string[],
): StaticToolDescriptor {
  const schema = structuredClone(tool.inputSchema) as {
    properties?: { requests?: { items?: { properties?: { name?: Record<string, unknown> } } } };
  };
  const nameProp = schema.properties?.requests?.items?.properties?.name;
  if (nameProp === undefined || opNames.length === 0) return { ...tool };
  nameProp['enum'] = [...opNames];
  return { ...tool, inputSchema: schema };
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
  return { name: op.name, description: description(op), inputSchema: buildOpInputSchema(op) };
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
