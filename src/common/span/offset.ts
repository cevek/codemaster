// The 1-based `Loc` ↔ 0-based offset bridge — the §16 invariant-1 hotspot. Every proof
// span's honesty rides on this conversion being done in exactly one place: a span whose
// text drifts off its range by one is a lie.
//
// Conventions: `Loc.line` / `Loc.col` are 1-based (editor-clickable). Offsets are
// 0-based character indexes into the source string. Line breaks are `\n`; a `\r\n`
// source still works because `\r` is just a character before the break.

/** Precomputed start offsets of each line. `lineStarts[0]` is always 0. */
export type LineStarts = readonly number[];

export function computeLineStarts(source: string): LineStarts {
  const starts = [0];
  for (let i = 0; i < source.length; i++) {
    if (source.charCodeAt(i) === 10 /* \n */) starts.push(i + 1);
  }
  return starts;
}

/** 1-based (line, col) → 0-based offset. Returns `undefined` for a position outside
 *  the source — out-of-range is reported, never clamped into a plausible-looking lie. */
export function locToOffset(
  lineStarts: LineStarts,
  sourceLength: number,
  line: number,
  col: number,
): number | undefined {
  if (line < 1 || line > lineStarts.length || col < 1) return undefined;
  const lineStart = lineStarts[line - 1];
  if (lineStart === undefined) return undefined;
  const offset = lineStart + (col - 1);
  const lineEnd = line < lineStarts.length ? lineStarts[line] : sourceLength;
  // `col` may point one past the last character of the line (an end position).
  if (lineEnd === undefined || offset > lineEnd) return undefined;
  return offset > sourceLength ? undefined : offset;
}

/** 0-based offset → 1-based (line, col). Returns `undefined` when out of range. */
export function offsetToLoc(
  lineStarts: LineStarts,
  sourceLength: number,
  offset: number,
): { line: number; col: number } | undefined {
  if (offset < 0 || offset > sourceLength) return undefined;
  // Binary search: greatest lineStart <= offset.
  let lo = 0;
  let hi = lineStarts.length - 1;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    const start = lineStarts[mid];
    if (start !== undefined && start <= offset) lo = mid;
    else hi = mid - 1;
  }
  const lineStart = lineStarts[lo];
  if (lineStart === undefined) return undefined;
  return { line: lo + 1, col: offset - lineStart + 1 };
}
