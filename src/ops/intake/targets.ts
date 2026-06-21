// Coerce the elements of an op's target-array field (§7 Postel) — `source.targets`. Each
// element may arrive as a bare STRING (`["src/x.ts:12:3"]`, `["ts:Foo@…"]`) which is parsed
// into the canonical `{symbolId|file+line+col|name}` object, or as an OBJECT carrying the
// `symbol`/`target` aliases (the same liberal spellings the top-level tsTarget intake accepts),
// which get renamed to `name`/`symbolId` and have a `name`-string smart-parsed. The owning
// op names the field in `OpDefinition.intake.targetArray`.

import { classifyTargetString, targetFields, targetRewriteLabel } from './smart-string.ts';

export interface TargetArrayResult {
  notes: string[];
}

const ELEMENT_ALIASES: Readonly<Record<string, string>> = { symbol: 'name', target: 'symbolId' };

/** Normalize one object element in place: apply symbol/target aliases, then smart-string `name`. */
function normalizeObjectElement(el: Record<string, unknown>, notes: Set<string>): void {
  for (const [from, to] of Object.entries(ELEMENT_ALIASES)) {
    if (from in el && !(to in el)) {
      el[to] = el[from];
      delete el[from];
      notes.add(`targets[].${from}→${to}`);
    }
  }
  if (typeof el['name'] === 'string') {
    const classified = classifyTargetString(el['name']);
    const label = targetRewriteLabel(classified);
    if (label !== undefined) {
      delete el['name'];
      Object.assign(el, targetFields(classified));
      notes.add(`targets[].${label}`);
    }
  }
}

/** Coerce every element of the named target-array field, mutating `args`. A non-array value
 *  (a shape error) is left for the canonical gate to reject. */
export function coerceTargetArray(
  args: Record<string, unknown>,
  field: string | undefined,
): TargetArrayResult {
  const notes = new Set<string>();
  if (field === undefined) return { notes: [] };
  const value = args[field];
  if (!Array.isArray(value)) return { notes: [] };
  let stringConverted = false;
  const coerced = value.map((el: unknown): unknown => {
    if (typeof el === 'string') {
      stringConverted = true;
      return targetFields(classifyTargetString(el));
    }
    if (el !== null && typeof el === 'object' && !Array.isArray(el)) {
      const obj = { ...(el as Record<string, unknown>) };
      normalizeObjectElement(obj, notes);
      return obj;
    }
    return el;
  });
  args[field] = coerced;
  if (stringConverted) notes.add(`${field}[]: string→target`);
  return { notes: [...notes] };
}
