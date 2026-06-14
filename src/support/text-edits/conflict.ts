// Overlap detection for an edit set — the guard that keeps `applyEdits` from silently
// clobbering one splice with another. The honesty rule: two edits that would both rewrite
// the same character are a call-site bug, surfaced explicitly, never merged or dropped.
//
// What counts as a conflict: two edits whose `[start, end)` ranges intersect. What does
// NOT: a delete + insert pair sharing a `start` where at least one side is zero-length
// (the LS emits these; the tie-break in `apply.ts` orders them), and adjacent touching
// ranges (`[A,B)` then `[B,C)` — they border but share no character). Two *non-empty*
// edits sharing a start DO conflict — they co-own characters and merging them silently
// would clobber one, the exact lie this guard exists to prevent.

import type { TextEdit } from './apply.ts';

/** Thrown by `applyEdits` when two edits overlap. Carries both edits so the wrapping
 *  mutating op can report which sites collided (it converts this to a `ToolFailure`). */
export class EditConflictError extends Error {
  readonly a: TextEdit;
  readonly b: TextEdit;
  constructor(a: TextEdit, b: TextEdit) {
    super(`overlapping edits [${a.start},${a.end}) and [${b.start},${b.end})`);
    this.name = 'EditConflictError';
    this.a = a;
    this.b = b;
  }
}

/** Return an overlapping pair, or `null` when the set is conflict-free. Pure and
 *  order-independent: it sorts a local copy by start, then sweeps tracking the furthest
 *  `end` seen so far. A later edit whose start falls strictly before that furthest end —
 *  and does not merely share a start with the edit that set it — intersects an earlier
 *  range and is reported. Tracking the running max (not just the immediate predecessor)
 *  catches an enclosing range overlapping a non-adjacent edit. */
export function findConflict(edits: readonly TextEdit[]): { a: TextEdit; b: TextEdit } | null {
  if (edits.length < 2) return null;
  const sorted = [...edits].sort((a, b) =>
    a.start !== b.start ? a.start - b.start : a.end - b.end,
  );
  let maxEndEdit: TextEdit | undefined;
  for (const cur of sorted) {
    if (
      maxEndEdit !== undefined &&
      cur.start < maxEndEdit.end &&
      !allowedCoincident(maxEndEdit, cur)
    ) {
      return { a: maxEndEdit, b: cur };
    }
    if (maxEndEdit === undefined || cur.end > maxEndEdit.end) maxEndEdit = cur;
  }
  return null;
}

/** A shared-start pair is allowed only when at least one side is a zero-length insert —
 *  a delete+insert (or insert+insert) at one position, which the tie-break orders without
 *  loss. Two non-empty edits at the same start genuinely overlap and are NOT exempted. */
function allowedCoincident(a: TextEdit, b: TextEdit): boolean {
  return a.start === b.start && (a.start === a.end || b.start === b.end);
}
