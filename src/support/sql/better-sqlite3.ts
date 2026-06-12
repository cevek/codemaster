// `better-sqlite3` impl of the `SqlRunner` seam (spec §2.1, §4). Synchronous, tiny,
// prebuilt. The native module is loaded LAZILY via `createRequire` on the first sql call
// — cold start (and every non-sql call) must never pay for it (§4.1). A failed native
// load returns an honest `ToolFailure` with the install hint, never a crash (§3.6).
//
// Known limitation (§4.5): better-sqlite3 is synchronous and has no interrupt — a
// pathological query (cartesian blowup) blocks this workspace's engine until done.
// Accepted for v1 (same class as a heavy LS call); the row bounds keep tables sane. Do
// NOT add threads for this.

import { createRequire } from 'node:module';
import type { Database as Db } from 'better-sqlite3';
import type { Result } from '../../core/result.ts';
import { fail, ok, messageOfThrown } from '../../common/result/construct.ts';
import { isReadOnlySelect } from './read-only.ts';
import { validateTableName, type SqlCell, type SqlColumn, type SqlRunner } from './runner.ts';

/** The constructor as `require` returns it — we only need to open one `:memory:` db. */
type DatabaseCtor = new (filename: string) => Db;

const INSTALL_HINT = 'install it from the project root: `npm i better-sqlite3`';

export function createSqliteRunner(): Result<SqlRunner> {
  let Database: DatabaseCtor;
  try {
    // Lazy: the require happens here, on the first sql-carrying call, not at import.
    const require = createRequire(import.meta.url);
    Database = require('better-sqlite3') as DatabaseCtor;
  } catch (thrown) {
    return fail({
      tool: 'better-sqlite3',
      message: `SQL engine 'better-sqlite3' failed to load (${messageOfThrown(thrown)}) — ${INSTALL_HINT}`,
    });
  }

  let db: Db;
  try {
    db = new Database(':memory:');
  } catch (thrown) {
    return fail({
      tool: 'better-sqlite3',
      message: `could not open in-memory SQLite database: ${messageOfThrown(thrown)}`,
    });
  }

  const runner: SqlRunner = {
    register(table, columns, rows) {
      const aliasError = validateTableName(table);
      if (aliasError !== undefined) throw new Error(aliasError);
      const ddlCols = columns.map((c) => `"${c.name}" ${affinity(c)}`).join(', ');
      db.exec(`CREATE TABLE "${table}" (${ddlCols})`);
      if (rows.length === 0 || columns.length === 0) return;
      // Prepared INSERT — values are bound, never string-interpolated (§4.4).
      const placeholders = columns.map(() => '?').join(', ');
      const stmt = db.prepare(`INSERT INTO "${table}" VALUES (${placeholders})`);
      const insertMany = db.transaction((batch: ReadonlyArray<ReadonlyArray<SqlCell>>) => {
        for (const row of batch) stmt.run(...(row as SqlCell[]));
      });
      insertMany(rows);
    },

    query(sql, maxRows) {
      // Layer 1: leading-keyword gate. Layer 2: prepare() rejects multi-statement.
      if (!isReadOnlySelect(sql)) {
        throw new Error('only a single read-only SELECT (or WITH … SELECT) statement is allowed');
      }
      const stmt = db.prepare(sql);
      // Layer 3: catches DML/DDL/ATTACH a leading SELECT/WITH could still front.
      if (!stmt.readonly) {
        throw new Error('statement is not read-only (no INSERT/UPDATE/DELETE/DDL/ATTACH)');
      }
      stmt.raw(true); // rows as arrays, not objects — matches SqlCell[][]
      const columns = stmt.columns().map((c) => c.name);
      const out: SqlCell[][] = [];
      let total = 0;
      for (const row of stmt.iterate()) {
        total++;
        if (out.length < maxRows) out.push(row as SqlCell[]);
      }
      return { columns, rows: out, total };
    },

    dispose() {
      try {
        db.close();
      } catch {
        // Best-effort: the database is ephemeral and about to be GC'd regardless.
      }
    },
  };

  return ok(runner);
}

function affinity(column: SqlColumn): string {
  switch (column.type) {
    case 'int':
      return 'INTEGER';
    case 'real':
      return 'REAL';
    case 'text':
      return 'TEXT';
  }
}
