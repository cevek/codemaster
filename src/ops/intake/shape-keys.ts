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
