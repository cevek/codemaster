// Coerce a bare scalar into a one-element array for a field the op's schema declares as an
// array (§7 Postel) — the dogfood fail `construction_sites {pathInclude: "local-api"}` meant
// `["local-api"]`. Top-level fields only; the array fields are derived from the op's
// `argsSchema` (a pure ZodArray field — see `arrayFieldsOf`), not a per-op allowlist, so the
// coercion can never silently miss an op. An existing array (or an absent field) is left untouched.

import { isScalar } from './scalar.ts';

export interface CoerceArrayResult {
  notes: string[];
}

/** Wrap each declared array-field's scalar value in a one-element array, mutating `args`. */
export function coerceArrayFields(
  args: Record<string, unknown>,
  fields: readonly string[] | undefined,
): CoerceArrayResult {
  const notes: string[] = [];
  if (fields === undefined) return { notes };
  for (const field of fields) {
    if (!(field in args)) continue;
    const value = args[field];
    if (isScalar(value)) {
      args[field] = [value];
      notes.push(`${field}→[…]`);
    }
  }
  return { notes };
}
