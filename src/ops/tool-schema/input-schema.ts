// The ADVERTISED JSON Schema for an op (§11) — generated from the op's canonical zod `argsSchema`
// so the schema a client gates on can never drift from the one that actually validates, then
// enriched with the output-shape flags (apply/verbosity/…) and the `anyOf` one-of constraints
// `required` cannot express.
//
// It lives HERE (L3, beside the op definitions) rather than in the MCP facade because it has TWO
// consumers: `tools/list` (mcp/op-tools.ts, L5) and `status {op:"<name>"}` (daemon, L4). One builder,
// one output — that identity is what makes `status` a usable window on the real advertised contract
// (t-981812) instead of a second, drifting description of it.

import { z } from 'zod';
import type { AnyOpDefinition } from '../registry.ts';

/** A JSON-Schema object as advertised in `tools/list` (MCP `Tool.inputSchema`). */
export interface JsonSchemaObject {
  type: 'object';
  properties?: Record<string, unknown>;
  required?: readonly string[];
  /** "at least one of" branches (`[{required:['symbolId']},…]`) — see `OpDefinition.requiredOneOf`. */
  anyOf?: ReadonlyArray<{ required: readonly string[] }>;
  /** Zod hoists a recursive sub-schema (our `JsonValue`) here and leaves a `$ref` pointing at it;
   *  dropping it would ship a schema with an UNRESOLVABLE reference — invalid for any consumer that
   *  actually resolves refs, and silently unvalidated for one that doesn't (t-029489). */
  $defs?: Record<string, unknown>;
}

/** Built schemas are memoized per op definition: `tools/list` and every `status {op}` call ask for
 *  the same immutable object, so the generation runs once and the two surfaces are identical by
 *  reference, not merely by construction. */
const CACHE = new WeakMap<AnyOpDefinition, JsonSchemaObject>();

export function buildOpInputSchema(op: AnyOpDefinition): JsonSchemaObject {
  const cached = CACHE.get(op);
  if (cached !== undefined) return cached;
  const built = build(op);
  CACHE.set(op, built);
  return built;
}

function build(op: AnyOpDefinition): JsonSchemaObject {
  let gen: unknown;
  try {
    gen = z.toJSONSchema(op.argsSchema, { unrepresentable: 'any', io: 'input' });
  } catch {
    // §3 never-crash: an unrepresentable/cyclic schema degrades to flags-only rather than taking
    // the facade down. The canonical zod gate still validates the call either way.
    gen = undefined;
  }
  const g = gen !== null && typeof gen === 'object' ? (gen as Record<string, unknown>) : {};
  const genProps =
    g['properties'] !== null && typeof g['properties'] === 'object'
      ? (g['properties'] as Record<string, unknown>)
      : {};
  const required = Array.isArray(g['required']) ? (g['required'] as string[]) : undefined;
  // The generated top-level keys are WHITELISTED, never spread: `additionalProperties:false` must
  // NOT reach the advertised schema, because the §7 liberal intake accepts off-canonical spellings
  // (`symbol`, `path`, `max_results`) that arrive as unknown keys — a strict harness would reject
  // them at its own boundary, BEFORE the normalizer that understands them ever runs.
  const defs =
    g['$defs'] !== null && typeof g['$defs'] === 'object'
      ? (g['$defs'] as Record<string, unknown>)
      : undefined;
  return {
    type: 'object',
    properties: dropUnboundedMaxima({ ...genProps, ...flagProperties(op) }),
    ...(required !== undefined ? { required } : {}),
    ...(op.requiredOneOf !== undefined && op.requiredOneOf.length > 0
      ? { anyOf: op.requiredOneOf.map((branch) => ({ required: branch })) }
      : {}),
    ...(defs !== undefined ? { $defs: defs } : {}),
  };
}

/** Strip a `maximum` equal to `Number.MAX_SAFE_INTEGER` — the honest but useless byproduct of
 *  `z.number().int().positive()`, which zod renders on ~36 `line`/`col`/`limit` fields. It bounds
 *  nothing a caller could hit, and it is pure noise re-loaded into every agent's context every
 *  session (§11: the token tax is deliberate, so it is also budgeted). Recursive: the fields sit
 *  one level down under `filter`/`edit` objects too. */
function dropUnboundedMaxima<T>(node: T): T {
  if (Array.isArray(node)) return node.map(dropUnboundedMaxima) as T;
  if (node === null || typeof node !== 'object') return node;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(node)) {
    if (k === 'maximum' && v === Number.MAX_SAFE_INTEGER) continue;
    out[k] = dropUnboundedMaxima(v);
  }
  return out as T;
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
