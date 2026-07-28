// The col-less (`file+line`) miss message — split out of `resolve-target.ts` (300-line cap).
// Its whole job is the §3.6 refusal contract: say only what this resolver knows, and name a
// remedy the agent can actually run from here.

import type ts from 'typescript';
import { nameWithMore } from '../../common/truncate/name-with-more.ts';

/** Declarations named in a miss / pick-list message before `+N more` (§3.4) — a generated or
 *  minified line can hold hundreds. */
export const LINE_DECL_PREVIEW = 8;

/** The col-less miss message. Every arm names a remedy that CAN reach a symbol from here, and
 *  claims only what this resolver knows:
 *   · out of range   → no column helps; the line number is what to check.
 *   · has declarations → they are listed with their columns (the pick list).
 *   · in range, none  → we anchor no DECLARATION (never "the source declares nothing": a binding
 *     pattern declares symbols this resolver cannot anchor), and a column still reaches a symbol
 *     USED there — hedged, since a blank/comment line holds none.
 *  With `name` given it never re-offers a bare `name` (the state the call is already in, t-175046)
 *  but does offer `name`+`file` WITHOUT `line`, which is a different addressing and the one that
 *  reaches a top-level declaration elsewhere in the file. */
export function lineMissMessage(
  sourceFile: ts.SourceFile,
  file: string,
  line: number,
  name: string | undefined,
  all: readonly { name: string; col: number }[],
): string {
  // No line COUNT in the message: `getLineStarts()` counts the empty line a trailing newline
  // opens, so "has N lines" would overstate by one on almost every file — a small lie is still
  // one. The bound is used for the branch, not quoted as a fact.
  const outside = line < 1 || line > sourceFile.getLineStarts().length;
  const head = `no declaration${name !== undefined ? ` named '${name}'` : ''} on ${file}:${line}`;
  if (outside) {
    // "outside", not "past the end": the same branch guards a non-positive line (unreachable
    // through the op boundary, which validates a positive int, but this is a plugin-level entry
    // too), and it matches the wording the col-carrying path already uses for the same fact.
    return `${head} — line ${line} is outside ${file}, so NO column resolves there: check the line number`;
  }
  const there =
    all.length > 0
      ? ` (declared there: ${nameWithMore(
          all.map((d) => `${d.name} at col ${d.col}`),
          LINE_DECL_PREVIEW,
        )})`
      : ' (the line anchors no declaration — a column still resolves a symbol USED there, if the line holds one)';
  const alt =
    name !== undefined
      ? `, or drop 'line' (name+file resolves the file's TOP-LEVEL declaration of that name)`
      : ` or a 'name'`;
  return `${head}${there} — pass file:line:col (the column)${alt}`;
}
