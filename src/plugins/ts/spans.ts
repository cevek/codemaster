// The ONE place TS 0-based offsets become 1-based `Loc`/`Span` (core/span.ts warns:
// never let the two conventions mix, or proof spans drift by one). Every span emitted
// by the ts plugin is built here, with the verbatim text read from the same SourceFile
// that produced the range — so a span can't disagree with the source it proves.

import type ts from 'typescript';
import type { RepoRelPath } from '../../core/brands.ts';
import type { Span } from '../../core/span.ts';
import { elideString } from '../../common/truncate/elide-string.ts';

const SPAN_TEXT_CAP = 400;

/** Hard ceiling for any one span's text, even a declaration body (§3.1/§3.2): a
 *  generated monster file must not emit a multi-MB span. Matches the renderer's
 *  output-level `RENDER_CHAR_CAP`, so a single span can fill an answer but never blow it. */
const SPAN_TEXT_CEILING = 20_000;

export function spanFromRange(
  sourceFile: ts.SourceFile,
  file: RepoRelPath,
  start: number,
  end: number,
  // Default caps reference sites tight (the proof, not the payload); declaration / source
  // spans pass a generous cap so `full` verbosity carries the whole body (§3.1).
  textCap: number = SPAN_TEXT_CAP,
): Span {
  const cap = Math.min(textCap, SPAN_TEXT_CEILING);
  const s = sourceFile.getLineAndCharacterOfPosition(start);
  const e = sourceFile.getLineAndCharacterOfPosition(end);
  const raw = sourceFile.text.slice(start, end);
  // Route the char-elide through the chokepoint (§3.4). The cut text rides `Span.text`; the `elided`
  // flag is this span's own honesty channel (a consumer re-fetches at `full` via the loc), so no `…`
  // recovery marker is appended — the base `elideString` (bare `…`) is exactly right here.
  const cut = elideString(raw, cap);
  return {
    file,
    line: s.line + 1,
    col: s.character + 1,
    endLine: e.line + 1,
    endCol: e.character + 1,
    text: cut.text,
    ...(cut.elided ? { elided: true } : {}),
  };
}

/** The generous per-span cap for declaration / source bodies (§3.1) — full bodies, still
 *  bounded by `SPAN_TEXT_CEILING`. */
export const DECL_TEXT_CAP = SPAN_TEXT_CEILING;

/** 1-based (line, col) → TS offset; undefined when out of range (reported, never
 *  clamped into a plausible-looking position). */
export function offsetOfLoc(
  sourceFile: ts.SourceFile,
  line: number,
  col: number,
): number | undefined {
  if (line < 1 || col < 1) return undefined;
  try {
    return sourceFile.getPositionOfLineAndCharacter(line - 1, col - 1);
  } catch {
    return undefined;
  }
}
