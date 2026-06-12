# codemaster — micro-guide for agents

You have a `codemaster` MCP server: a stateful codebase inspector for TS/React repos.
A warm TypeScript LanguageService + domain plugins answer structural/semantic queries
**with proof** (`file:line` + verbatim source span). Prefer it over grep for anything
about _symbols and meaning_; keep grep for literal text (strings, comments, logs).

## Tools (exactly three)

| Tool     | Use                                                                          |
| -------- | ---------------------------------------------------------------------------- |
| `status` | **Call first.** Active plugins + the per-repo op catalogue with arg schemas. |
| `op`     | Run one op: `{name, args, verbosity?, format?, root?}`.                      |
| `batch`  | Several ops in one round-trip, results in order, one freshness view.         |

The op set is per-repo (depends on active plugins) — `status` is the source of truth.

## Current ops

| Op                         | Args                                                                   | Returns                                                                 |
| -------------------------- | ---------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `search_symbol`            | `{query, limit?, kind?, exportedOnly?, pathExclude?, pathInclude?}`    | matches + chainable `SymbolId`s (fuzzy, Cmd+T-style)                    |
| `find_definition`          | target                                                                 | definition site(s)                                                      |
| `find_usages`              | target or `{symbols: string[]}` + `{limit?, role?, groupBy?, filter?}` | semantic refs — catches aliased imports and JSX `<B/>` that grep misses |
| `importers_of`             | `{module}` — path or specifier (`@/…` aliases resolve via tsconfig)    | files importing / re-exporting from the module                          |
| `expand_type`              | target                                                                 | resolved type signature + docs                                          |
| `scss_classes`             | `{file?}`                                                              | SCSS class declarations                                                 |
| `find_unused_scss_classes` | `{}`                                                                   | classes with no usage observed in TS/TSX                                |

### find_usages refinements (generic AST-level, you supply the names)

- `role` — what the reference _syntactically is_: `jsx` (`<X/>` tags, closing tags
  deduped) · `call` · `type` · `import` · `reexport` (`export { X } from …` barrel
  surface — never collapsed) · `read` · `write` · `decl`.
- `collapseImports` (default `true`) — an `import` is bookkeeping for the usages that
  follow it, so it is hidden when its file _also_ has a real usage; the hidden count
  comes back as `importsCollapsed` + a microtext line. Import-only files (unused /
  side-effect imports) and re-exports always stay. Pass `collapseImports:false` or
  `role:'import'` to list every import. (In `sql` mode collapse is off — the table keeps
  every import row so `NOT IN` stays honest.)
- When a `role` filter returns **0**, the answer still shows the full role distribution
  and suggests the dominant role (`0 usages role=read (all roles: type=12 import=3 …)`) —
  so "0" is never mistaken for "none exist".
- `groupBy: 'enclosing'` — roll refs up to the nearest enclosing named declaration:
  "which components render `<DialogContent>`" in one call. Rows are
  `encloserId · kind · xCount (roles)`, sorted by count; encloser ids chain into
  further ops. Under `sql`, the grouped rows carry `encloser`, `encloser_file`,
  `encloser_kind`, and `is_exported` (1/0) — so `WHERE is_exported = 1` keeps only
  exported declarations and drops the synthetic `(top-level X)` module nodes without a
  name LIKE-heuristic.
- `filter: {pathExclude/pathInclude (globs), kind, exportedOnly}` — kind/exportedOnly
  apply to enclosers. Filtered-out refs are reported as `excludedByFilter` — a filter
  never masquerades as completeness.
- `symbols: ['A','B']` — several targets in one call, sectioned; unresolvable names
  come back under `unresolved`, never silently dropped.

```js
op({
  name: 'find_usages',
  args: {
    symbols: ['DialogContent', 'SheetContent', 'PopoverContent'],
    role: 'jsx',
    groupBy: 'enclosing',
    filter: { pathExclude: ['**/components/ui/**', '**/*.test.*'] },
  },
});
```

**target** = one of: `{symbol: 'ts:…'}` (a SymbolId from a previous answer) ·
`{name: 'Button'}` (must be unambiguous; on ambiguity you get the candidate list) ·
`{file, line, col}` (1-based).

## Chaining

Every symbol answer carries an opaque `SymbolId` (`ts:Button@src/Button.tsx:12:14`).
Feed it to the next op — no re-searching. If the file changed since you got the handle,
the answer carries `handle: rebound …` (with proof + confidence) or `gone` — never a
silent retarget.

## Reading answers (the honesty contract)

- **Proof spans**: every fact has `file:line` + verbatim `text`. You can verify without
  re-reading the file.
- **Confidence**: `certain` (proven by the type system) · `partial` (incomplete — e.g.
  a dynamic access in scope) · `dynamic` (only reachable through computed
  dispatch) · `unresolved`. A `partial`/`dynamic` claim is honest uncertainty — do not
  treat it as certain.
- **Truncation is explicit**: `… N more (shown X/Y; hint)`. No marker = the list is
  complete.
- **`freshness: PENDING …`** — the index hadn't fully caught up with very recent edits;
  re-run or treat as approximate. No note / `current @commit` = answer reflects the
  working tree as of the call. Your own file edits are picked up automatically (no
  cache to bust).
- **`freshness: reindexed N file(s) at entry`** — codemaster caught N drifted files on
  read and reindexed them _before_ answering, so this answer already reflects them. You
  don't have to trust that a just-made edit was picked up — it says so, even in terse.
- **`FAIL tool=… — message`** — codemaster could not do it and says so instead of
  guessing. Fall back to your own tools (grep/read) for that question.
- **`bad args: … — valid: {…}`** — your call was malformed; the message ends with a
  minimal valid call you can copy and adapt.

## When codemaster vs your own tools

- "where is X defined / used", "what type is this", "is this SCSS class dead" →
  **codemaster** (one call, semantic, proof-carrying).
- literal string/comment/log search, non-TS/SCSS files, repos in other languages →
  **grep/read**.
- Don't delegate codemaster lookups to file-reading subagents — the warm index already
  did that work.

## Examples

```js
op({ name: 'search_symbol', args: { query: 'Button' } });
op({ name: 'find_usages', args: { name: 'createEngine', limit: 50 } });
op({ name: 'find_usages', args: { symbol: 'ts:Button@src/Button.tsx:1:14' } });
op({ name: 'expand_type', args: { file: 'src/app.ts', line: 12, col: 8 } });
batch({
  requests: [
    { name: 'scss_classes', args: {} },
    { name: 'find_unused_scss_classes', args: {} },
  ],
});
```

## Relational post-filtering — `sql` over op outputs

Need an **anti-join, join, negation, or aggregate** over op results (e.g. "components
that render `<Input>` but are NOT inside a `useAppForm` form")? Don't make several calls
and merge by hand. Alias each request with `as`, then pass a top-level `sql` — a single
**read-only SELECT** runs over the requests' rows in an ephemeral in-memory SQLite
database that exists only for that one call. Only the SQL result returns (`return: 'all'`
to also get each op's rows).

```js
batch({
  requests: [
    {
      as: 'renders',
      name: 'find_usages',
      args: { symbols: ['Input'], role: 'jsx', groupBy: 'enclosing' },
    },
    { as: 'forms', name: 'find_usages', args: { symbols: ['useAppForm'], groupBy: 'enclosing' } },
  ],
  sql: `SELECT DISTINCT encloser, file, line FROM renders
        WHERE encloser NOT IN (SELECT encloser FROM forms)`,
});

// single-op sugar — the op's table is aliased `t`:
op({
  name: 'search_symbol',
  args: { query: 'use' },
  sql: "SELECT name, file FROM t WHERE kind='function'",
});
```

- **Each tabular op declares its columns** — `status` lists them on a `columns:` line.
  Every table has a `confidence` column; `partial`/`dynamic` rows are included, so drop
  them in your `WHERE` if you want only `certain` facts.
- **Producers run UNCAPPED in sql-mode** (the per-op `limit` is only a token guard), so
  `COUNT(*)` / `NOT IN` see every row — not a truncated slice.
- **Honesty channels you must respect:** a `⚠ PARTIAL table(s)=[…]` line means a producer
  hit the 100k-row hard bound and was truncated — **do NOT trust `NOT IN` / anti-joins
  over a partial table** (a missing row would be a false "absent"). A `note:` line carries
  unresolved (absent) target symbols and filter exclusions. Result rows past 1,000 are cut
  with an explicit `… more (shown N/total)` — add a `LIMIT` or aggregate.
- **Read-only only**: anything but one `SELECT`/`WITH … SELECT` (INSERT/PRAGMA/ATTACH/
  multi-statement) is a pointed `bad_args`; a bad column name lists every table's columns.
- **Reading the table**: rows are `|`-separated; `NULL` renders as `∅` (an empty string
  renders as `""`), and a cell containing `|` is quoted. For machine parsing pass a
  batch-level `format: 'json'` (and `verbosity?`) — these flags render the SQL result
  itself, distinct from the per-request flags that format each producer under `return:'all'`.

## Verbosity (default: terse)

- `terse` (default) — spans render as clickable `file:line:col`, no source text.
- `normal` — `file:line:col · first line of the source (≤60ch)`.
- `full` — verbatim proof-text spans (use for ONE symbol you're about to act on, not
  for lists).
- `format: 'json'` — the raw machine envelope (full spans) for programmatic chaining.

Output is self-capped: an oversized answer is cut at a line boundary with an explicit
`!! OUTPUT CAPPED` marker — treat that as "narrow the query", never as a complete list.
