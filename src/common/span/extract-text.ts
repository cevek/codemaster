// Extract the verbatim text a span covers — what gets embedded as `Span.text` proof.
// Built strictly on the one Loc↔offset bridge (./offset.ts) so a drifted conversion
// cannot exist in two places.

import type { Span } from '../../core/span.ts';
import { computeLineStarts, locToOffset } from './offset.ts';

/** Returns the exact source text in `[start, end)` of the span, or `undefined` when
 *  the span does not fit the source (caller decides how to report that — it usually
 *  means the file changed and the span must not be emitted as proof). */
export function extractText(
  source: string,
  span: Pick<Span, 'line' | 'col' | 'endLine' | 'endCol'>,
): string | undefined {
  const lineStarts = computeLineStarts(source);
  const start = locToOffset(lineStarts, source.length, span.line, span.col);
  const end = locToOffset(lineStarts, source.length, span.endLine, span.endCol);
  if (start === undefined || end === undefined || end < start) return undefined;
  return source.slice(start, end);
}
