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

/** Apply `edits` to `original`. Edits may arrive in any order. We sort ascending and walk the
 *  ORIGINAL string ONCE behind a `cursor`, emitting `original[cursor, start)` then the edit text —
 *  we never re-slice the GROWING output at a raw offset, so an edit's text always lands relative to
 *  the original coordinates it was computed in.
 *
 *  Coincident edits at one anchor are the subtle case the single-pass exists for. The TS "Move to
 *  file" refactor, merging several names into an existing (multi-line) import,
 *  emits MANY zero-length inserts at the SAME offset, meant to apply in ARRAY ORDER (its own
 *  `applyChanges` reverse-applies to that end). The sort is by `start` asc, ties by `end` asc, and
 *  Array.sort is STABLE — so those coincident inserts keep their incoming array order and
 *  concatenate in it (a mutate-and-reslice loop instead interleaves them, dropping/doubling a
 *  separator — the multi-line-import-merge bug). End-asc also keeps a coincident insert+delete pair
 *  as insert-text-then-delete-text. PRECONDITION: `edits` arrives in TS's original textChange order
 *  (callers pass `fc.textChanges` verbatim, never reversed).
 *
 *  Truly overlapping edits (distinct starts whose ranges intersect) are a call-site bug and throw
 *  via `EditConflictError` (checked up front) — never a silent clobber; so `cursor` only ever fails
 *  to advance for a coincident zero-length insert, which appends with no slice. Adjacent touching
 *  ranges (`[A,B)` then `[B,C)`) do not overlap and are allowed. */
export function applyEdits(original: string, edits: readonly TextEdit[]): string {
  if (edits.length === 0) return original;
  const conflict = findConflict(edits);
  if (conflict) throw new EditConflictError(conflict.a, conflict.b);
  const sorted = [...edits].sort((a, b) =>
    a.start !== b.start ? a.start - b.start : a.end - b.end,
  );
  let out = '';
  let cursor = 0;
  for (const e of sorted) {
    if (e.start > cursor) out += original.slice(cursor, e.start);
    out += e.text;
    if (e.end > cursor) cursor = e.end;
  }
  return out + original.slice(cursor);
}
