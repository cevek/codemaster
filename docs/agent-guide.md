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
  deduped) · `call` · `type` · `import` · `read` · `write` · `decl`.
- `groupBy: 'enclosing'` — roll refs up to the nearest enclosing named declaration:
  "which components render `<DialogContent>`" in one call. Rows are
  `encloserId · kind · xCount (roles)`, sorted by count; encloser ids chain into
  further ops.
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
- **`FAIL tool=… — message`** — codemaster could not do it and says so instead of
  guessing. Fall back to your own tools (grep/read) for that question.
- **`DISPATCH bad_args/unknown_op`** — your call was malformed; the message includes
  the expected shape / a did-you-mean.

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

## Verbosity (default: terse)

- `terse` (default) — spans render as clickable `file:line:col`, no source text.
- `normal` — `file:line:col · first line of the source (≤60ch)`.
- `full` — verbatim proof-text spans (use for ONE symbol you're about to act on, not
  for lists).
- `format: 'json'` — the raw machine envelope (full spans) for programmatic chaining.

Output is self-capped: an oversized answer is cut at a line boundary with an explicit
`!! OUTPUT CAPPED` marker — treat that as "narrow the query", never as a complete list.
