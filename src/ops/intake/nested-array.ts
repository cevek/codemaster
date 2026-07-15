// Coerce a bare scalar into a one-element array for a NESTED array field — one level down (§7
// Postel). The top-level `coerceArrayFields` reads only the schema's top-level shape, so a
// `find_usages { filter: { pathExclude: 'x' } }` (pathExclude lives under `filter`) is missed
// and fails the gate. The nested array subfields are DERIVED from the schema (`nestedArrayFieldsOf`),
// not a per-op allowlist, so this can't silently miss a nested field.
//
// `args` is only a SHALLOW clone (see normalize.ts), so `args[objKey]` is the caller's nested
// object — it is cloned before mutation, never mutated in place.

import { isScalar } from './scalar.ts';

interface CoerceNestedResult {
  notes: string[];
}

/** For each object field with declared array subfields, wrap a scalar subfield in a one-element
 *  array, mutating `args` (via a fresh clone of the nested object). */
export function coerceNestedArrayFields(
  args: Record<string, unknown>,
  nested: ReadonlyMap<string, ReadonlySet<string>>,
): CoerceNestedResult {
  const notes: string[] = [];
  for (const [objKey, subs] of nested) {
    const obj = args[objKey];
    if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) continue;
    const clone = { ...(obj as Record<string, unknown>) };
    let changed = false;
    for (const sub of subs) {
      const value = clone[sub];
      if (sub in clone && isScalar(value)) {
        clone[sub] = [value];
        notes.push(`${objKey}.${sub}→[…]`);
        changed = true;
      }
    }
    if (changed) args[objKey] = clone;
  }
  return { notes };
}
