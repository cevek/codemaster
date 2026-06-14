// Apply a set of `[start, end) → text` splices to a string — the substrate every
// mutating op writes through (rename/move/extract/codemod all reduce to an edit set).
// Pure: offsets are 0-based character indexes into the source; the caller converts from
// proof-span `Loc`s through `common/span/offset.ts` before reaching here.

import { findConflict, EditConflictError } from './conflict.ts';

/** A single splice: replace `[start, end)` of the source with `text`. A pure insert is
 *  `start === end`; a pure delete is `text === ''`. */
export interface TextEdit {
  start: number;
  end: number;
  text: string;
}

/** Apply `edits` to `original`. Edits may arrive in any order; we sort right-to-left so
 *  an applied splice never shifts the offsets of edits still to its left.
 *
 *  Tie-break: when two edits share `start`, the one with the LARGER `end` applies first,
 *  so a delete-then-insert pair at one position (`[A,B)` then `[A,A)`) is deterministic —
 *  exactly the shape the TS LS emits, and the shape the spec's coincident-start case
 *  relies on. Truly overlapping edits (distinct starts whose ranges intersect) are a bug
 *  at the call site and throw via `EditConflictError` — never a silent clobber. Adjacent
 *  touching ranges (`[A,B)` then `[B,C)`) do not overlap and are allowed. */
export function applyEdits(original: string, edits: readonly TextEdit[]): string {
  if (edits.length === 0) return original;
  const conflict = findConflict(edits);
  if (conflict) throw new EditConflictError(conflict.a, conflict.b);
  const sorted = [...edits].sort((a, b) =>
    a.start !== b.start ? b.start - a.start : b.end - a.end,
  );
  let out = original;
  for (const e of sorted) out = out.slice(0, e.start) + e.text + out.slice(e.end);
  return out;
}
