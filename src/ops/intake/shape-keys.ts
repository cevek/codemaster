// The canonical top-level arg keys an op's zod schema accepts — read off the schema so the
// flag-lift step (§7 Postel) never lifts a key the op itself defines as a real arg. zod v4
// keeps `.shape` accessible THROUGH a `.refine()` wrapper (every symbol-addressed op refines
// its strictObject), so a single structural read covers both plain and refined schemas. A
// schema with no readable shape (a union, a non-object) yields an empty set → the caller
// then lifts unconditionally, which is safe (no op names a field after an OpFlag key).

import type { z } from 'zod';

/** The canonical top-level keys of an op's args schema, empty when the schema is not a
 *  (possibly refined) object. A single typed structural read — not `any`. */
export function canonicalKeys(schema: z.ZodType<unknown>): ReadonlySet<string> {
  const shaped = schema as { shape?: Record<string, unknown> };
  const shape = shaped.shape;
  if (shape === undefined || typeof shape !== 'object') return new Set();
  return new Set(Object.keys(shape));
}

// A zod v4 schema node, read structurally (no `any`): `.def.type` is the discriminant and
// the wrapper nodes (optional/default/nullable) carry the wrapped node in `.def.innerType`.
interface ZodNode {
  readonly def?: { readonly type?: string; readonly innerType?: ZodNode };
}
const ARRAY_WRAPPERS: ReadonlySet<string> = new Set(['optional', 'default', 'nullable']);

/** True when a field schema is a PURE array — a `ZodArray`, optionally wrapped in
 *  `optional`/`default`/`nullable` (chained). A `union` (e.g. `z.union([z.string(),
 *  z.array(...)])`) that already accepts a scalar is NOT pure and returns false, so the
 *  scalar→array coercion never breaks a field that legitimately takes a bare scalar. */
function isPureArraySchema(field: ZodNode): boolean {
  let node: ZodNode | undefined = field;
  let guard = 0;
  while (node?.def !== undefined && ARRAY_WRAPPERS.has(node.def.type ?? '') && guard++ < 16) {
    node = node.def.innerType;
  }
  return node?.def?.type === 'array';
}

// Schemas are stable per-op singletons, so the structural read is memoized per schema
// (never a per-call recompute — §1 never-hang) and shared across requests.
const ARRAY_FIELDS_CACHE = new WeakMap<object, ReadonlySet<string>>();

/** The canonical top-level fields whose schema is a pure array (§7 Postel) — the source of
 *  truth for scalar→array coercion, derived from `op.argsSchema` itself (no per-op allowlist).
 *  Empty when the schema is not a (possibly refined) object. */
export function arrayFieldsOf(schema: z.ZodType<unknown>): ReadonlySet<string> {
  const cached = ARRAY_FIELDS_CACHE.get(schema as object);
  if (cached !== undefined) return cached;
  const shape = (schema as { shape?: Record<string, ZodNode> }).shape;
  const fields = new Set<string>();
  if (shape !== undefined && typeof shape === 'object') {
    for (const [key, field] of Object.entries(shape)) {
      if (isPureArraySchema(field)) fields.add(key);
    }
  }
  ARRAY_FIELDS_CACHE.set(schema as object, fields);
  return fields;
}
