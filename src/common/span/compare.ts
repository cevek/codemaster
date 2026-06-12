// Span set-relations: contains / intersects / equals. Spans are 1-based, end-exclusive
// in neither dimension — `endLine:endCol` points one past the last character, matching
// the TS compiler's end positions after the boundary conversion (see ./offset.ts).
// Comparisons are file-aware: spans in different files never relate.

import type { Span } from '../../core/span.ts';

/** -1 | 0 | 1 ordering of two (line, col) positions. */
function comparePos(line: number, col: number, otherLine: number, otherCol: number): number {
  if (line !== otherLine) return line < otherLine ? -1 : 1;
  if (col !== otherCol) return col < otherCol ? -1 : 1;
  return 0;
}

/** True when `outer` fully contains `inner` (same file; boundaries may touch). */
export function contains(outer: Span, inner: Span): boolean {
  if (outer.file !== inner.file) return false;
  return (
    comparePos(outer.line, outer.col, inner.line, inner.col) <= 0 &&
    comparePos(inner.endLine, inner.endCol, outer.endLine, outer.endCol) <= 0
  );
}

/** True when the two spans share at least one character (same file). Zero-width
 *  touching at a boundary does not count as intersection. */
export function intersects(a: Span, b: Span): boolean {
  if (a.file !== b.file) return false;
  return (
    comparePos(a.line, a.col, b.endLine, b.endCol) < 0 &&
    comparePos(b.line, b.col, a.endLine, a.endCol) < 0
  );
}

/** True when both spans cover exactly the same range of the same file. Text is not
 *  compared — two spans over one range are the same span even if one elided its text. */
export function equals(a: Span, b: Span): boolean {
  return (
    a.file === b.file &&
    a.line === b.line &&
    a.col === b.col &&
    a.endLine === b.endLine &&
    a.endCol === b.endCol
  );
}
