// Dense rendering of a sql-mode result (spec §5.6). The SQL `data` is
// `{ columns, rows, partial?, notes? }`; the generic dense renderer would scatter each
// cell onto its own line, so a relation gets its own small renderer: a header line then
// one row per line, cells `|`-separated (unambiguous when a text cell contains spaces).
//
// Honesty channels surface here, not silently: a `partial` table (a producer hit
// MAX_TABLE_ROWS) prints a ⚠ banner naming the tables, and producer `notes` (unresolved
// targets, filter exclusions, dynamic modules) print verbatim. Row-level truncation
// (MAX_RESULT_ROWS) rides the envelope's `truncated`, rendered by render-result.

import type { JsonValue } from '../../core/json.ts';

interface SqlTableData {
  columns: string[];
  rows: JsonValue[][];
  partial?: { boundedTables: string[]; reason: string };
  notes?: string[];
}

/** Structural detector for the sql-result shape: `columns` (string[]) + `rows` (array of
 *  arrays). Anything else falls through to the generic dense renderer. */
export function isSqlTableData(value: JsonValue): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const v = value as Record<string, JsonValue>;
  const columns = v['columns'];
  const rows = v['rows'];
  return (
    Array.isArray(columns) &&
    columns.every((c) => typeof c === 'string') &&
    Array.isArray(rows) &&
    rows.every((r) => Array.isArray(r))
  );
}

/** Render the sql-result shape. Call only after `isSqlTableData` passed — the cast is
 *  sound there. */
export function renderSqlTable(value: JsonValue): string {
  const data = value as unknown as SqlTableData;
  const lines: string[] = [];
  const header = data.columns.join(' | ');
  lines.push(`${header}  (${data.rows.length} row${data.rows.length === 1 ? '' : 's'})`);
  for (const row of data.rows) lines.push(row.map(renderCell).join(' | '));

  if (data.partial !== undefined) {
    lines.push(
      `⚠ PARTIAL table(s)=[${data.partial.boundedTables.join(',')}] — ${data.partial.reason}`,
    );
  }
  for (const note of data.notes ?? []) lines.push(`note: ${note}`);
  return lines.join('\n');
}

/** SQL NULL renders as ∅ — a stable token that never occurs in paths/identifiers, so it
 *  can't be confused with an empty string (which renders as `""`). */
const NULL_TOKEN = '∅';

function renderCell(cell: JsonValue): string {
  if (cell === null) return NULL_TOKEN;
  if (typeof cell === 'number' || typeof cell === 'boolean') return String(cell);
  if (typeof cell === 'string') {
    // Quote (via JSON) only when the raw value would be ambiguous in a `|`-delimited row:
    // an embedded `|`/newline breaks the split; empty or whitespace-padded text would
    // vanish; a literal `∅` would masquerade as NULL. Otherwise pass through bare.
    const ambiguous =
      cell === '' ||
      cell === NULL_TOKEN ||
      cell.includes('|') ||
      cell.includes('\n') ||
      cell !== cell.trim();
    return ambiguous ? JSON.stringify(cell) : cell;
  }
  // Nested structures shouldn't occur in a projected cell, but never throw on output.
  return JSON.stringify(cell);
}
