// Post-LS normalizer for the relocated symbol's leading doc comment. The TS "Move to a new file" /
// "Move to file" refactors emit the moved declaration with a SPURIOUS blank line inserted between an
// ADJACENT leading comment (the symbol's JSDoc) and the declaration — `*/\n\nexport const X` where
// the source had `*/\nexport const X`. Typecheck-clean (it's a comment) → the §2.8 gate never sees
// it → the doc silently detaches from what it documents.
//
// SOURCE-FAITHFUL, never over-glue: the LS PRESERVES the gap of a comment the source had blank-line-
// DETACHED from the decl (a floating note that travels with the symbol). Blindly collapsing would
// glue such a comment — a new lie about the author's intent. So we only shrink the OUTPUT gap down to
// the SOURCE gap (`sourceGap`, measured by `sourceLeadingGap`); a detached comment (sourceGap ≥ 2) is
// left exactly as the LS produced it. We never ADD blank lines, only remove the spurious insertion.

import ts from 'typescript';
import { applyEdits } from '../../../../support/text-edits/apply.ts';
import { countNewlines, topLevelDeclName } from '../extract/statements.ts';

/** Shrink the leading-comment→declaration gap of the relocated symbol (`declName`) in `text` down to
 *  `sourceGap` newlines, removing only the blank line(s) the LS spuriously inserted. No-op when the
 *  decl isn't found, carries no leading comment, or its output gap already matches the source. */
export function reattachLeadingDoc(text: string, declName: string, sourceGap: number): string {
  // Only own-line comments are doc-adjacency cases; an inline `/*…*/ decl` (sourceGap 0) is left as
  // the LS produced it rather than risk joining a comment onto the decl's line.
  if (sourceGap < 1) return text;
  const sf = ts.createSourceFile(
    '__reattach__.tsx',
    text,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const stmt = sf.statements.find((s) => topLevelDeclName(s) === declName);
  if (stmt === undefined) return text;

  const ranges = ts.getLeadingCommentRanges(text, stmt.getFullStart());
  if (ranges === undefined || ranges.length === 0) return text;
  const last = ranges[ranges.length - 1];
  if (last === undefined) return text;

  const declStart = stmt.getStart(sf);
  const gap = text.slice(last.end, declStart); // whitespace between the comment and the decl
  const outputNewlines = countNewlines(gap);
  if (outputNewlines <= sourceGap) return text; // nothing spurious to remove (incl. detached comment)

  // Rebuild the gap with exactly `sourceGap` newlines, preserving the decl's own-line indentation
  // (the run of spaces/tabs after the final newline).
  const indent = gap.slice(gap.lastIndexOf('\n') + 1);
  return applyEdits(text, [
    { start: last.end, end: declStart, text: '\n'.repeat(sourceGap) + indent },
  ]);
}
