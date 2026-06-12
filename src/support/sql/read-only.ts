// Read-only gate for user SQL (spec §4.2). Three layers defend the ephemeral database;
// this module is the first (cheap, syntactic). The impl adds the other two: a single
// prepared statement (better-sqlite3's `prepare()` rejects multi-statement strings) and
// `Statement.readonly` (rejects DML/DDL/ATTACH that a leading-keyword check alone misses,
// e.g. WITH-then-DELETE).
//
// Comments are stripped ONLY to find the leading keyword — the original SQL is what runs.
// So a string literal that happens to contain `--` can at worst make us reject a valid
// query (safe), never let a write through.

/** Strip SQL line comments (dash-dash) and C-style block comments. */
function stripSqlComments(sql: string): string {
  return sql.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ');
}

/** True when the statement begins with `SELECT` or `WITH` after comments are removed.
 *  The first of the three read-only layers (§4.2). */
export function isReadOnlySelect(sql: string): boolean {
  return /^\s*(select|with)\b/i.test(stripSqlComments(sql));
}
