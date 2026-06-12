# Spec: SQL post-filtering over op outputs (`batch + as + sql`)

Status: **approved for implementation**. Owner: next implementing agent.
Read ARCHITECTURE.md §1 (north star), §3 (trust contract), §11 (MCP surface), §12
(output) and CONTRIBUTING.md before starting. This spec is the contract; where it is
silent, those documents rule.

## 1. Problem & idea

Ops return semantically exact slices (the LS catches aliases/JSX that grep misses),
but agents keep needing **relational algebra over those slices** — anti-joins
("components that render `<Input>` but are NOT enclosed in a `useAppForm` form"),
joins, aggregates, negations. Today that means several calls + hand-merging in the
agent's context, or worse, falling back to grep.

Design: each `batch` request may be aliased (`as`); its tabular projection is loaded
into an **ephemeral in-memory SQLite database that lives only for this one call**; a
single read-only `sql` SELECT runs across all aliased tables; only the SQL result
returns to the agent.

The snapshot is ephemeral ⇒ **there is nothing to invalidate**. The LS stays the only
oracle (§3.1); SQLite is a stateless evaluator over one call's freshly-produced rows.
This is NOT a cache and NOT a second index — never persist it.

```js
batch({
  requests: [
    {
      as: 'renders',
      name: 'find_usages',
      args: {
        symbols: ['Input', 'Textarea', 'Switch'],
        role: 'jsx',
        groupBy: 'enclosing',
        filter: { pathExclude: ['**/components/ui/**'] },
      },
    },
    { as: 'forms', name: 'find_usages', args: { symbols: ['useAppForm'], groupBy: 'enclosing' } },
  ],
  sql: `SELECT DISTINCT encloser, file, line FROM renders
        WHERE encloser NOT IN (SELECT encloser FROM forms)`,
});
```

## 2. Fixed decisions (do not relitigate)

1. **Engine: `better-sqlite3`** (regular dependency + `@types/better-sqlite3` dev).
   Synchronous, tiny, prebuilt binaries. Hide it behind a seam (`support/sql/`) so the
   engine never knows which SQL engine runs — a DuckDB impl can drop in later.
2. **Ephemeral per call.** One `:memory:` database per `sql`-carrying call; created,
   seeded, queried, closed. No state across calls, no disk, ever.
3. **In sql-mode, producers run UNCAPPED.** The per-op `limit` is a token guard; rows
   going into SQLite cost no agent tokens. A capped producer feeding `NOT IN` makes
   the SQL answer a lie (§3.4). Instead there is one **hard safety bound:
   `MAX_TABLE_ROWS = 100_000` rows per table** — hitting it marks the entire SQL
   result `partial` with the table named (never silent).
4. **The token cap moves to the SQL output**: the rendered result goes through the
   existing `renderResult` cap (`!! OUTPUT CAPPED`), plus row-level truncation
   `{shown, total, hint: 'add LIMIT / aggregate'}` at `MAX_RESULT_ROWS = 1_000`.
5. **When `sql` is present, only the SQL result returns** (the per-request results are
   dropped). `return: 'all'` opts back into receiving both.
6. **Single-op sugar**: `op({name, args, sql})` ≡ a batch of one request aliased `t`.
   Implement ONE machinery in the engine; the op-tool form is MCP-schema sugar only.
7. **Producers stay seed/scope-bounded** (symbols/module/path args), as all current
   ops are. No "whole-universe" producers.

## 3. The tabular contract — `OpDefinition.table`

Extend `ops/registry.ts`:

```ts
export type ColumnType = 'text' | 'int' | 'real';
export interface TableSpec<D> {
  /** Stable column set for this op — independent of args. Mode-dependent fields are
   *  nullable rather than appearing/disappearing (SQL must be writable blind). */
  columns: ReadonlyArray<{ name: string; type: ColumnType }>;
  /** Pure projection of the op's Data into rows (null for absent values). */
  rows(data: D): ReadonlyArray<ReadonlyArray<string | number | null>>;
}
// OpDefinition gains: readonly table?: TableSpec<D>;
```

Rules:

- Column names: `snake_case`, stable, documented by being declared (they surface in
  `status` automatically — see §6).
- **Every table includes a `confidence` column** (`'certain'|'partial'|'dynamic'|
'unresolved'`). partial/dynamic rows are included, never pre-filtered — if the
  agent's SQL drops them, that is the agent's explicit choice.
- One op = one relation. Ops whose output is not list-shaped simply have no `table`
  (and using them under `sql` is a pointed `bad_args`).

Initial table specs to ship (one PR-sized unit each is fine):

| Op                         | Columns                                                                                                                                                                                       |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `find_usages`              | `symbol, file, line, col, role, encloser, encloser_id, encloser_kind, count, confidence` — flat rows: `encloser*`/`count` NULL; grouped rows: `file/line/col` of the encloser, `count` filled |
| `search_symbol`            | `id, name, kind, container, file, line, col, confidence`                                                                                                                                      |
| `importers_of`             | `module, file, line, imports, confidence`                                                                                                                                                     |
| `scss_classes`             | `name, file, line, col, confidence`                                                                                                                                                           |
| `find_unused_scss_classes` | `name, file, line, col, confidence, note`                                                                                                                                                     |

`unresolved` entries of multi-symbol `find_usages` are NOT rows (they describe absent
targets); they must surface in the SQL result's envelope as a note instead — dropping
them silently would hide an unanswered question.

## 4. `support/sql/` — the seam and the sandbox

```ts
// support/sql/runner.ts (seam — types only)
export interface SqlRunner {
  register(table: string, columns: ..., rows: ...): void;
  /** Validated read-only SELECT; returns column names + rows, capped. */
  query(sql: string, maxRows: number): { columns: string[]; rows: unknown[][]; total: number };
  dispose(): void;
}
// support/sql/better-sqlite3.ts (impl)
export function createSqliteRunner(): Result<SqlRunner>;
```

Sandbox requirements (all violations → pointed `bad_args`/`ToolFailure`, never a
crash; §3.6):

1. `:memory:` database; `better-sqlite3` loaded **lazily** on first sql call (cold
   start must not pay for it). A failed native load → `ToolFailure{tool:'sql'}` with
   the install hint.
2. **Read-only enforcement**: strip SQL comments, require the statement to match
   `/^\s*(select|with)\b/i`; `better-sqlite3`'s `prepare()` already rejects
   multi-statement strings — keep that (do not use `exec` for user SQL). Never call
   `loadExtension`. `ATTACH`/`PRAGMA`/DML are statements of their own, so the
   single-SELECT gate covers them; add a unit test for each anyway.
3. Table aliases (`as`) validated `^[a-z_][a-z0-9_]{0,30}$` and not a SQLite keyword —
   an alias is interpolated into DDL, treat it as hostile input.
4. Seeding uses prepared INSERTs (or a single multi-row prepared statement) — values
   are NEVER string-interpolated.
5. **Known limitation, document in code + agent guide**: better-sqlite3 is synchronous
   and has no interrupt; a pathological query (cartesian blowup) blocks that
   workspace's engine until done. Accepted for v1 (same class as a heavy LS call,
   §2/§8); the row bounds keep table sizes sane. Do NOT add threads for this.
6. SQL error (unknown column/table, syntax) → `DISPATCH bad_args` whose message lists
   **all available tables with their columns** — the agent has no other way to see the
   schema mid-flight.

## 5. Engine flow (`daemon/engine.ts`)

Batch entry already captures freshness once. Add:

1. Validate: `sql` present ⇒ every request's op has a `table`; aliases unique+valid
   (default alias: `t` for a single request, `t0..tN` otherwise).
2. Run requests sequentially as today, but with an internal flag (engine-level, NOT an
   agent-visible OpFlag) telling the op runner to use `limit = unbounded` semantics
   (§2.3). A request that returns a dispatch error or `ok:false` **fails the whole
   sql call** with that error — running SQL over a missing table would silently
   produce wrong joins.
3. Project rows via `op.table.rows(data)`, enforce `MAX_TABLE_ROWS`.
4. `createSqliteRunner()` → register tables → `query(sql, MAX_RESULT_ROWS)` → dispose
   (in `finally`).
5. Build the SQL `Result`: `data = { columns, rows }`; envelope carries: batch
   freshness note; `partial` + named tables if any hard bound was hit; truncation if
   rows were capped; producer `excludedByFilter`/`unresolved` notes aggregated.
6. Rendering: dense text — header line `col1 col2 …`, one row per line (the existing
   dense renderer handles arrays of arrays; add a small header special-case in
   `format/`). `format:'json'` returns the machine envelope as usual.

## 6. Surface changes

- `mcp/schema.ts`: `batch` gains `as?` per request, top-level `sql?: string`,
  `return?: 'sql'|'all'` (default `'sql'` when sql present); `op` gains `sql?`.
  Update the handwritten JSON Schemas AND the zod boundary.
- `status`: each op with a `table` lists its columns on one line, e.g.
  `columns: symbol,file,line,col,role,encloser,encloser_id,encloser_kind,count,confidence`.
- `docs/agent-guide.md`: new section with the anti-join example, the
  uncapped-producers note, and the "SQL result partial ⇒ do not trust NOT IN" rule.
- `SERVER_INSTRUCTIONS` (mcp/schema.ts): one added sentence pointing at sql-in-batch.

## 7. Tests (§16 — every one against an independent oracle)

1. **Anti-join correctness by construction**: fixture where components A,B render
   `<Input>`, only B sits under `useAppForm` ⇒ SQL anti-join returns exactly A.
2. **Uncapped producers**: fixture with > default-limit usages; assert the SQL sees
   all rows (count via `SELECT COUNT(*)`), while the same op WITHOUT sql still
   truncates at its limit.
3. **Hard bound honesty**: `MAX_TABLE_ROWS` lowered via test seam ⇒ result is
   `partial` and names the table.
4. **Result-row truncation**: explicit `{shown,total}` past `MAX_RESULT_ROWS` (lower
   it via seam too — no 100k-row fixtures).
5. **Sandbox**: `INSERT/PRAGMA/ATTACH/multi-statement/'; DROP` and a hostile alias →
   pointed errors, engine alive afterwards (follow-up op succeeds).
6. **Schema-in-error**: bad column name ⇒ message contains the table's column list.
7. **Envelope**: freshness note present; `unresolved` symbol surfaces as a note;
   failed producer fails the call (no partial-table joins).
8. Format golden for the table rendering (paired with assertions above, never alone).

## 8. Non-goals

- No persistence of any kind (the ephemerality IS the design — see wishlist for the
  rejected alternatives).
- No write/DDL SQL, no extensions, no ATTACH.
- No unscoped producers ("all symbols in the universe").
- No cross-call tables, no cursor/pagination state.
- No DuckDB in v1 (the seam exists precisely so it can come later without touching
  the engine).

## 9. Definition of done

Everything in CONTRIBUTING "Done means", plus: `npm run fix-and-check` green; all §7
tests green; `better-sqlite3` added (regular dep) and absent from
`knip.jsonc` ignoreDependencies once imported; ARCHITECTURE.md §11 (batch), §14
(dependencies) and §15 (tree: `support/sql/`) updated to present state; docs/plan.md
box ticked; `docs/agent-guide.md` updated; no file > 300 lines; the engine remains
transport-agnostic (nothing in `support/sql/` or the ops knows about MCP).
