// The ONE place TS 0-based offsets become 1-based `Loc`/`Span` (core/span.ts warns:
// never let the two conventions mix, or proof spans drift by one). Every span emitted
// by the ts plugin is built here, with the verbatim text read from the same SourceFile
// that produced the range — so a span can't disagree with the source it proves.

import type ts from 'typescript';
import type { RepoRelPath } from '../../core/brands.ts';
import type { Span } from '../../core/span.ts';

const SPAN_TEXT_CAP = 400;

export function spanFromRange(
  sourceFile: ts.SourceFile,
  file: RepoRelPath,
  start: number,
  end: number,
): Span {
  const s = sourceFile.getLineAndCharacterOfPosition(start);
  const e = sourceFile.getLineAndCharacterOfPosition(end);
  const raw = sourceFile.text.slice(start, end);
  const elided = raw.length > SPAN_TEXT_CAP;
  return {
    file,
    line: s.line + 1,
    col: s.character + 1,
    endLine: e.line + 1,
    endCol: e.character + 1,
    text: elided ? `${raw.slice(0, SPAN_TEXT_CAP)}…` : raw,
    ...(elided ? { elided: true } : {}),
  };
}

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
