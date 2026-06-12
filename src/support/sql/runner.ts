// The SQL seam (spec §4). A `SqlRunner` is a stateless evaluator over one call's
// freshly-produced rows: register N named tables, run ONE read-only SELECT, dispose.
// It never knows which engine runs underneath (better-sqlite3 today; a DuckDB impl can
// drop in behind the same interface). Nothing here knows about ops, plugins, or MCP —
// it speaks only columns and cells.
//
// Layering: this is L1 support. The `SqlColumnType` union is structurally identical to
// `ops/registry.ts`'s `ColumnType`, so the engine passes an op's `table.columns` straight
// through without an upward import.

/** Declared storage affinity for a column. SQLite is dynamically typed; this is a hint.
 *  Structurally identical to `ops/registry.ts`'s `ColumnType`. */
type SqlColumnType = 'text' | 'int' | 'real';

export interface SqlColumn {
  readonly name: string;
  readonly type: SqlColumnType;
}

/** One projected cell — the only value shapes that cross into SQLite. */
export type SqlCell = string | number | null;

interface SqlQueryResult {
  /** Result column names, in select order. */
  columns: string[];
  /** Rows, capped at the `maxRows` passed to `query`. */
  rows: SqlCell[][];
  /** Full row count the query produced, before the cap — so truncation is honest (§2.4). */
  total: number;
}

export interface SqlRunner {
  /** Create + seed one table. Values are bound via prepared statements, never
   *  interpolated (§4.4). Throws on a hostile table name or a seeding failure — the
   *  caller turns that into an honest `ToolFailure`/`bad_args`, never a crash (§3.6). */
  register(
    table: string,
    columns: ReadonlyArray<SqlColumn>,
    rows: ReadonlyArray<ReadonlyArray<SqlCell>>,
  ): void;
  /** Run a validated read-only SELECT and return at most `maxRows` rows plus the true
   *  total. Throws on any non-read-only / multi-statement input or a SQL error. */
  query(sql: string, maxRows: number): SqlQueryResult;
  dispose(): void;
}

/** Hard safety bound: rows projected into ONE table (§2.3). Hitting it marks the whole
 *  SQL result `partial` with the table named — a capped table feeding `NOT IN` would
 *  otherwise lie. Also the uncapped-producer limit ops use in sql-mode. */
export const DEFAULT_MAX_TABLE_ROWS = 100_000;

/** Row-level cap on the SQL *result* (§2.4): past it the answer is truncated with an
 *  explicit `{shown,total,hint}` — distinct from the per-table hard bound above. */
export const DEFAULT_MAX_RESULT_ROWS = 1_000;

/** An `as` alias is interpolated into DDL, so it is hostile input (§4.3): a strict shape
 *  plus a reserved-word check. Returns an error message, or `undefined` when valid. */
const ALIAS_RE = /^[a-z_][a-z0-9_]{0,30}$/;

export function validateTableName(name: string): string | undefined {
  if (!ALIAS_RE.test(name)) {
    return `table alias '${name}' must match ${ALIAS_RE.source} (lowercase, starts with a letter/_, ≤31 chars)`;
  }
  if (SQLITE_KEYWORDS.has(name)) {
    return `table alias '${name}' is a reserved SQL keyword — pick another`;
  }
  return undefined;
}

/** SQLite reserved keywords (lowercased; the alias regex already forces lowercase). */
const SQLITE_KEYWORDS = new Set<string>([
  'abort',
  'action',
  'add',
  'after',
  'all',
  'alter',
  'always',
  'analyze',
  'and',
  'as',
  'asc',
  'attach',
  'autoincrement',
  'before',
  'begin',
  'between',
  'by',
  'cascade',
  'case',
  'cast',
  'check',
  'collate',
  'column',
  'commit',
  'conflict',
  'constraint',
  'create',
  'cross',
  'current',
  'current_date',
  'current_time',
  'current_timestamp',
  'database',
  'default',
  'deferrable',
  'deferred',
  'delete',
  'desc',
  'detach',
  'distinct',
  'do',
  'drop',
  'each',
  'else',
  'end',
  'escape',
  'except',
  'exclude',
  'exclusive',
  'exists',
  'explain',
  'fail',
  'filter',
  'first',
  'following',
  'for',
  'foreign',
  'from',
  'full',
  'glob',
  'group',
  'groups',
  'having',
  'if',
  'ignore',
  'immediate',
  'in',
  'index',
  'indexed',
  'initially',
  'inner',
  'insert',
  'instead',
  'intersect',
  'into',
  'is',
  'isnull',
  'join',
  'key',
  'last',
  'left',
  'like',
  'limit',
  'match',
  'materialized',
  'natural',
  'no',
  'not',
  'nothing',
  'notnull',
  'null',
  'nulls',
  'of',
  'offset',
  'on',
  'or',
  'order',
  'others',
  'outer',
  'over',
  'partition',
  'plan',
  'pragma',
  'preceding',
  'primary',
  'query',
  'raise',
  'range',
  'recursive',
  'references',
  'regexp',
  'reindex',
  'release',
  'rename',
  'replace',
  'restrict',
  'returning',
  'right',
  'rollback',
  'row',
  'rows',
  'savepoint',
  'select',
  'set',
  'table',
  'temp',
  'temporary',
  'then',
  'ties',
  'to',
  'transaction',
  'trigger',
  'unbounded',
  'union',
  'unique',
  'update',
  'using',
  'vacuum',
  'values',
  'view',
  'virtual',
  'when',
  'where',
  'window',
  'with',
  'without',
]);
