# Spec: read-side polish from agent field feedback (round 1)

Status: **approved**. Source: two real agent sessions using codemaster on production
repos, findings reproduced first-hand by dogfooding against this repo. Implements six
fixes in three stages (one PR each). Read [ARCHITECTURE.md](../ARCHITECTURE.md) §1, §3,
§12 and [CONTRIBUTING.md](../CONTRIBUTING.md) before starting.

**Out of scope** (separate specs later, do not start them here): cross-repo
per-request `root` in batch; textual-occurrence overlay on `find_usages`
(`text: true`); the `i18n` plugin (plan.md Phase 3).

---

## Why (one paragraph)

Field feedback praised exactly the trust-contract surfaces (proof spans, ambiguity
messages, honest truncation) and stumbled in two areas: **read-side depth** ("show me
what's _inside_ / the _source_", not just "where") and **DX wrapping** (errors,
hints, discoverability). Nothing here changes the architecture; everything deepens
existing contracts.

---

## Stage 1 — call-shape ergonomics + freshness visibility

Zones: `mcp/`, `format/render/`, `core/result.ts`, `daemon/` (freshness plumbing).

### 1.1 Examples become data, not strings

Today `OpDefinition.example` is a free-form pseudo-JS string (`"op({name:'…', …})"`),
and the status guidance literally prints `batch([...])` while the real tool schema is
`{requests: [...]}` — this cost a field agent ~4 failed calls. Fix the **class** of
bug, not the instance:

- Change `OpDefinition.example` from `string` to a structured value:
  `{ args: JsonValue, flags?: { verbosity?, sql?, … } }`. `format/render/render-status.ts`
  composes the display string from it in one canonical shape (exact tool-args JSON).
- **Anti-drift test (the point of the change):** for every registered op, its
  `example.args` must parse against that op's own `argsSchema`; every
  `TOOL_DESCRIPTORS` example (see 1.2) must parse against the corresponding zod tool
  schema (`opToolSchema` / `batchToolSchema`). A drifted example becomes a failing
  test, permanently.
- Fix the status guidance lines (find them via
  `find_usages {name:'…'}` / grep in `daemon/`): replace `batch([...])` with the exact
  call shapes: `op → {name, args, …}` · `batch → {requests: [{name, args, …}], …}`.

### 1.2 Validation errors carry a valid example

`badArgs()` in `mcp/server.ts:181` returns the raw zod message. Per §7 ("agents
author blind; pointed errors"):

- Each entry in `TOOL_DESCRIPTORS` gains `exampleCall: JsonValue` — a minimal valid
  arguments object for that tool.
- `badArgs(tool, message)` appends it:
  `bad args: <zod message> — valid: {"requests":[{"name":"find_usages","args":{"name":"Button"}}]}`.
- There is a second `badArgs` in `daemon/sql-batch.ts:216`. Inspect it; if it is true
  duplication, consolidate to one helper at the right layer; if it serves a different
  boundary, rename one of them so the names stop colliding.

### 1.3 Freshness: report reindex-at-entry, even in terse

Today a drift-triggered reindex at op entry is invisible (the answer is fresh and
silent); a field agent reported "I had to _trust_ that my edit was picked up".
`FreshnessNote` carries no field for it — this is an envelope change, not a render
change:

- `core/result.ts`: `FreshnessNote` gains `reindexed?: number` (count of files
  reindexed at entry for this call).
- The engine's batch-entry drift path (`daemon/freshness.ts` /
  `withBatchFreshness` in `daemon/engine.ts:342`) records the count when it reindexes.
- `format/render/render-result.ts` `renderFreshness`: when `reindexed > 0`, emit one
  line **at every verbosity including terse**:
  `freshness: reindexed N file(s) at entry @<commit>`. The existing
  `current`/`PENDING` behavior is unchanged.

### Stage 1 tests

| Claim                                     | Oracle                                                                                                                                        |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| every op example validates                | the op's own zod `argsSchema`                                                                                                                 |
| every tool example validates              | `opToolSchema` / `batchToolSchema`                                                                                                            |
| bad call → error contains a valid example | parse the example back through the schema                                                                                                     |
| reindex-at-entry is reported              | differential freshness test (watcher silenced, mutate, query) asserts the `reindexed` line; a clean terse query asserts **no** freshness line |

---

## Stage 2 — `find_usages` upgrades: role breakdown · `reexport` role · import collapse

Zones: `plugins/ts/usage-roles.ts`, `plugins/ts/queries.ts` (`findUsages`),
`ops/find-usages.ts`, `format/`.

### 2.1 Split `reexport` out of `import`

In `classifyRole`, the `ts.isExportSpecifier` branch currently returns `'import'`.
Make it a distinct role `'reexport'`. Update `UsageRole`, `USAGE_ROLES`, every
exhaustive switch, the op's `role` enum in its zod schema and `argsHint`. Re-exports
are barrel nodes — structurally load-bearing, and must never be collapsed (2.2).

### 2.2 Conditional import collapse (default on)

An import is bookkeeping for the usages that follow it — same spirit as the
`jsx-closing` drop (`usage-roles.ts:10`). But unlike `jsx-closing`, an import can be
the **only** reference in a file (unused import, side-effect import) — and then it is
the most interesting result, not noise. Hence _conditional_ collapse, never a filter:

- **Rule:** an `import`-role ref is dropped from output **iff its file has ≥ 1 ref
  with any other role**. Import-only files always stay. `reexport` refs always stay.
- New op arg `collapseImports?: boolean`, default `true` (in `UsageOptions` and the
  op's zod schema). `role: 'import'` queries are naturally unaffected (the question
  _is_ imports).
- **Counters never change:** `total` keeps counting everything. New field
  `importsCollapsed: number`; render a microtext line when > 0:
  `imports: N collapsed (their files appear via real usages) — collapseImports:false or role:'import' to list`
  — §3.4: a default filter must never read as completeness.
- **Grouped mode:** apply the same rule before rollup — the synthetic
  `(top-level X) · module · x1 (import)` rows disappear when their file has
  substantive refs (this was the main rollup noise observed in dogfooding).
- **SQL mode: NO collapse.** The same argument that makes capped tables lie under
  `NOT IN` (§11) applies: "files that import X but don't render it" needs the import
  rows. The `OpDefinition.table` projection must run on the **uncollapsed** ref set —
  verify the projection input path in `ops/find-usages.ts` explicitly.

### 2.3 Role breakdown on filtered-empty results

`role:'read'` on a type returns `total=0` with no clue (reproduced first-hand). The
distribution is free — `classifyRole` already runs on every ref before the filter:

- When `options.role` is set, count per-role pre-filter. `UsagesView` gains
  `roleBreakdown?: Record<string, number>`, populated whenever the role filter is
  active.
- Render, when the filtered result is empty:
  `0 usages role=read (all roles: type=12 import=3 decl=1 — try role:type)` — suggest
  the dominant role. When non-empty, a compact `(other roles: …)` tail at
  normal+ verbosity is enough.
- Generalized principle (state it in the code comment): **an empty filtered answer
  must show what the unfiltered answer looked like** — otherwise "0" is
  indistinguishable from "none exist", which is a §3.4-class lie.

### Stage 2 tests

| Claim                                                                 | Oracle                                                               |
| --------------------------------------------------------------------- | -------------------------------------------------------------------- |
| file with import+call → import hidden, counted in microtext           | fixture + assert on both the list and `importsCollapsed`             |
| import-only file → shown                                              | fixture                                                              |
| re-export → shown, role=`reexport`                                    | fixture; cold-LS reference check that the site is real               |
| sql table sees ALL import rows despite collapse                       | `SELECT count(*) … WHERE role='import'` equals the uncollapsed count |
| grouped mode: module-import row vanishes only when file has real refs | fixture                                                              |
| role-filtered 0 → breakdown + suggestion; counts correct              | run the same query unfiltered, compare counts                        |

---

## Stage 3 — read depth: declaration spans · `source` op · deep `expand_type`

Zones: `plugins/ts/` (new `declaration.ts`, `queries.ts`), `ops/` (new `source.ts`,
`expand-type.ts`).

### 3.1 Declaration spans (fixes the `find_definition` echo)

Root cause, verified: the LS definition `textSpan` covers only the **name token**, so
`find_definition` on a SymbolId echoes the identifier even at `verbosity:'full'` —
the data isn't there to render. Fix at the plugin, not the renderer:

- New `plugins/ts/declaration.ts`: `declarationNodeOf(sourceFile, namePos)` — walk up
  from the name token to the enclosing declaration node: `VariableStatement` (for
  `const X = …`), `FunctionDeclaration`, `ClassDeclaration`, `InterfaceDeclaration`,
  `TypeAliasDeclaration`, `EnumDeclaration`, `MethodDeclaration`,
  `PropertySignature`/`PropertyDeclaration`, `ModuleDeclaration`. Same walking spirit
  as `findEncloser` (`usage-roles.ts:61`) but returns the full node. Use
  `node.getStart()` (excludes leading comments) for v1 — doc text is already served
  by quick-info; revisit JSDoc inclusion only if asked.
- `SymbolView` gains `decl?: Span` (full declaration span, verbatim text included —
  `Span` already carries text). `findDefinitions` populates it.
- Render: terse → unchanged (`file:line:col`); normal → the declaration **header**
  (first line of `decl.text`); full → the whole declaration text. The global
  `RENDER_CHAR_CAP` already guards blowups.

### 3.2 New op: `source` (multi-target, the explore-style call)

The single biggest field gap ("80% of my Reads were 'show me the body'"). One call
returns the bodies of N symbols:

- `ops/source.ts`: args `{ targets: Target[] }` where `Target` is the existing
  ts-target shape (`symbol | name | file+line+col`) — reuse `tsTargetShape`; zod:
  non-empty array, cap length at ~20 with a pointed message.
- Per target: `id`, `name`, `kind`, `file:line`, and the full `decl` span text (via
  3.1). Unresolvable / ambiguous targets come back in an `unresolved` section with
  the same candidate-listing message style `find_usages {symbols}` already uses —
  never silently dropped.
- **Size to the answer (§12):** an overall char budget (reuse/parametrize
  `RENDER_CHAR_CAP` thinking): render bodies until the budget is hit, then collapse
  the remaining targets to `id + file:line + header line` with an explicit
  `… source elided for K targets (re-request individually)`.
- Routing note (comment, no code): `source` is ts-only today; when other plugins
  grow `sourceOf()`, dispatch by SymbolId prefix (§6). Do **not** build the generic
  dispatcher now.
- Wire into the op registry exactly like the existing ops (`bin.ts` `opsFor`), with a
  structured example (Stage 1.1 shape).

### 3.3 Deep `expand_type` (members, not just the header)

`expand_type` on an interface returns `interface X` and nothing else
(quick-info-only, `queries.ts:300` — reproduced). Expand structurally, **without
special-casing interfaces**:

- Args gain `depth?: number` (default 1, max 3) and `memberLimit?: number`
  (default ~40).
- Implementation in `plugins/ts/queries.ts` (split a new file if it crosses 300
  lines): node at offset → `checker.getTypeAtLocation` → **apparent type**:
  - object-like → `type.getProperties()`: per member `{ name, optional
(SymbolFlags.Optional), typeString (checker.typeToString of
getTypeOfSymbolAtLocation), inherited? (declaration's parent symbol ≠ this
type's symbol) }`;
  - union/intersection → one line per constituent (`typeToString`);
  - enum → members;
  - functions/others → quick-info already says it; keep as today.
- `depth > 1`: recurse into members whose type is an anonymous object literal;
  anti-cycle via a seen-set of type ids; depth cap honest (`… expand with depth:2`).
- Honesty: member list over `memberLimit` → explicit `… N more (raise memberLimit)`.
  Use `ts.TypeFormatFlags.NoTruncation` and apply our **own** per-string cap with an
  explicit marker — a silent `...` from the checker is a §3.4 violation.
- Result shape: existing `TypeView` + `members?: MemberView[]` +
  `constituents?: string[]`. Quick-info `about`/`doc` stay.

### Stage 3 tests

| Claim                                                                       | Oracle                                                                                    |
| --------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| every emitted span text == live file at range                               | `assertSpansValid` (§16 invariant 1) on every new answer shape                            |
| decl span covers the full declaration (incl. `export const … ;` for arrows) | fixture + byte-range compare against the file                                             |
| `find_definition` full verbosity contains the body                          | fixture                                                                                   |
| `source` multi-target: bodies + unresolved section + honest elision         | fixture; elision counts add up                                                            |
| `expand_type` members equal a cold `ts.Program`'s view of the same type     | fresh `createProgram` on the fixture (§16 oracle), compare member name/optional/type sets |
| interface with optional + inherited members; alias→union; depth=2 nested    | fixtures for each                                                                         |
| member cap is explicit, never silent                                        | fixture over `memberLimit`                                                                |

---

## Cross-cutting (every stage)

- `npm run fix-and-check` green; no file > 300 lines (watch `queries.ts` — it starts
  at 332: Stage 2/3 work there **must** split it; suggested seams:
  `usages.ts` / `definitions.ts` / `type-expand.ts`).
- Every new boundary zod-validated; every new external-tool call wrapped →
  `ToolFailure` (§3.6).
- Exhaustive switches over the extended `UsageRole` — the compiler must force every
  consumer of the union to acknowledge `reexport`.
- Docs at present state, same PR: `docs/agent-guide.md` (new op, new flags, role
  vocabulary incl. `reexport`, import-collapse microtext, `source` examples),
  `docs/plan.md` (tick/extend the relevant boxes), this spec's status line if scope
  shifts. ARCHITECTURE.md needs **no** changes — verify, don't assume.
- `status` is the public contract: after each stage, run it and confirm the
  catalogue/examples/columns reflect reality (Stage 1's anti-drift test should make
  this automatic).
- Dogfood as you go: use the codemaster MCP tools themselves for code navigation in
  this repo (`find_usages`, `search_symbol`, `importers_of`) — friction you hit is
  feedback; note it in the PR description.

## Definition of done (whole spec)

All three stages merged; every table above green against its oracle; the two field
scenarios replay cleanly: (a) `expand_type` on a DTO interface returns its fields,
(b) `find_definition` on a held SymbolId returns a signature+body instead of an echo,
(c) a `role`-misfiltered query explains itself, (d) an import-heavy `find_usages`
reads as usages, not bookkeeping, with an honest collapse count, (e) an invalid
`batch` call's error message alone is enough to author the corrected call.
