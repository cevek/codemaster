# Spec: the `schema` plugin — generated API types → endpoint cards (Phase 3 closure)

Status: **proposed** (task brief for an implementing agent). Read ARCHITECTURE.md §4 (parser per
domain — the schema cell), §5-L2/L3 (plugins + ops), §10 (config), §16 (honesty harness), and
CONTRIBUTING.md before starting. Refines [plan.md](plan.md) Phase 3.

## 1. Purpose

Complete the non-TS plugin trio — `scss` ✓, `i18n` ✓, **`schema` ✗**. The `schema` plugin reads a
project's **generated API type surface** (OpenAPI → TypeScript) and exposes **endpoint cards**
(method · path · path-params · query · body · response) so an agent can ask "what endpoints exist /
what's the shape of this request" in one call instead of spelunking a 1000-line generated file.
Op: **`list_endpoints`** (and the per-endpoint card it returns chains into `expand_type`).

## 2. The load-bearing decision — the input contract is REAL, not invented

Everything downstream is determined by **what the generated file actually looks like**. Do **not**
invent a schema format. **Mine the real shape** from the projects codemaster already runs over
(NDA-safe — extract the _shape_, neutral names, no proprietary endpoints):

- **amiro** (`/Users/cody/Dev/amiro`) — `src/api/generated/` (OpenAPI-generated TS: `types.ts`,
  `hooks.ts`, `api.ts`); ~570 LOC generated, string-literal-union statuses, `Record`-keyed paths.
- **backoffice** (`/Users/cody/Dev/backoffice`) — `openApiSchemes/<service>/` (the raw OpenAPI per
  service) + `packages/common` generated types; multiple services.

**Stage 1 is to characterize this shape and commit a concrete fixture that mirrors it** (e.g. the
`openapi-typescript` `paths`-interface style: `interface paths { '/users/{id}': { get: {...} } }`,
or the `operations` map, or a generated client's request/response types — whichever the real
generators emit). State in the spec which generator(s) the plugin targets; the reader is built to
that contract, with the fixture as the pinned example. ARCHITECTURE §4 frames this as a "TS-aware
reader over `schema.d.ts`" — confirm whether the real input is a `.d.ts`, a `.ts`, or raw OpenAPI
JSON/YAML, and target what's actually generated. If two generator shapes dominate, support the
common one first and state the other as a follow-up (no silent partial — §3.4).

## 3. Fixed decisions

- **Plugin, not op-level parsing.** A new `plugins/schema/` plugin owns the parse (its own cell,
  §4). It is a **TS-aware reader**: if the input is generated TS/`.d.ts`, read it through a cold
  `ts.Program` / the `ts` plugin's checker (declared `deps: ['ts']` if it leans on the ts plugin's
  type resolution) — do **not** hand-roll a TS parser. If the input is raw OpenAPI JSON, parse with
  `ts.parseJsonText` (the i18n-plugin pattern) — no new JSON-parser dep.
- **Endpoint card shape** (plain data, JsonValue-satisfying): `{ method, path, pathParams[],
query?, body?, response?, status? }` with **proof spans** (`file:line` into the generated source)
  for each — proof-carrying like every other plugin (§3.2). A type that can't be resolved is
  `unresolved`/`partial`, never guessed.
- **Config-gated** (§10). A `schema` config section (`entrypoint` — the generated file glob;
  `generator` — which shape) enables it; absent → the plugin doesn't load and `list_endpoints` isn't
  in the op catalogue (mirror how `i18n` is gated on `locales`). zod-validated, fail-fast.
- **Freshness** (§8). `freshness()` fingerprints the generated entrypoint file(s); `reindex` reparses
  on change; `pending()` surfaces staleness. One-shot parse per session is fine (ARCHITECTURE §4
  "one-shot per session") but it must honor the read-time freshness backstop.
- **No `i18n:`-style SymbolId yet** unless an op chains an endpoint handle (avoid dead exports / knip)
  — add the `schema:` handle with the first op that consumes one.

## 4. Stages

**Definition of done per stage** (§17 + CONTRIBUTING): `fix-and-check` green · an **oracle-backed**
test (cold reparse — §16) · ≤300 real-code lines/file · no upward import · new boundary
zod-validated · every external-tool call wrapped → `ToolFailure` · docs at present state · new dep
removed from `knip.jsonc` ignore.

### Stage 1 — characterize the real shape + commit the fixture

- **Build.** Mine amiro/backoffice generated output (NDA-safe). Decide the target generator shape(s).
  Commit `test/fixtures/repos/schema-app/` (or an inline fixture) — a concrete generated file in the
  real shape + a minimal `tsconfig`/config enabling the plugin. Document the input contract in this
  spec (flip its "decided" section).
- **Exit.** The input contract is written down and a real-shaped fixture is committed.

### Stage 2 — `plugins/schema/` plugin

- **Build.** Parse the generated entrypoint → endpoint cards with proof spans. `Plugin` lifecycle
  (`init`/`dispose`/`freshness`/`reindex`/`pending`). Public API e.g. `endpoints(): EndpointCard[]`
  / `endpoint(path, method)`. Reader wrapped → `ToolFailure` on parse/IO failure (never throw).
- **Port from.** None (net-new); follow the `i18n` plugin's shape (config-gated, JSON-or-TS reader,
  proof spans, freshness) as the template.
- **Oracle.** A cold independent reparse of the fixture (a second reader, or `ts.Program` +
  hand-enumerated expected cards) — the plugin's cards == the cold enumeration. Per-plugin freshness
  (edit the generated file with the watcher silenced → reindexed-or-FreshnessNote, never stale).
- **Exit.** Endpoint cards correct vs the cold oracle; freshness honest.

### Stage 3 — `ops/list-endpoints.ts`

- **Build.** `defineOp({ name: 'list_endpoints', requires: ['schema'], … })` → the cards, dense
  output (§12: `file:line`, explicit truncation, verbosity); register in `builtins.ts`; zod args
  (optional `pathInclude`/`method` filters). An `OpDefinition.table` (method/path/… columns) so it
  joins the SQL post-filter (§11) like the other list ops.
- **Oracle.** Op output == plugin cards (passthrough); golden + the cold oracle; SQL-table projection
  tested. Op-examples anti-drift (the example validates against the schema).
- **Exit.** `list_endpoints` in `status`; green.

### Stage 4 — config + docs

- **Build.** `schema` config section in `config/config.ts` (zod, `defineConfig` typed); wire into the
  composition root (`bin.ts` `pluginsFor`); ARCHITECTURE §4 parser-cell + §5 plugin list + §15 tree +
  plan.md Phase 3 box updated to present state.
- **Exit.** Config validated fail-fast; docs at present state; plan.md `schema` + `list_endpoints`
  boxes ticked.

## 5. Review protocol

- **architecture-reviewer** — `plugins/schema/` imports only core/common/support (+ `ts` per declared
  `deps`); op composes via the plugin's public API; no upward import; ≤300 lines.
- **bug-reviewer** — proof spans valid (§16 inv.1); an unresolvable endpoint type is `partial`/
  `unresolved`, never a guessed card; reader failure → `ToolFailure`, daemon live.
- **copy-paste-reviewer** — reuses the `ts` plugin's type resolution / the i18n JSON-reader pattern,
  not a hand-rolled parser; no second cold-Program builder beyond `test/helpers/cold-ls.ts`.
- **doc-sync-reviewer** — ARCHITECTURE §4/§5/§15 + plan.md + this spec's status reflect the shipped
  reality.

## 6. After this — the feature fork stays open

`schema` completes Phase 3. The next feature decision (deferred, owner's call) is **Phase 4 `react`**
— the base of the framework-plugin DAG (`react-query`/`tanstack-router`/`zustand` depend on it),
which unlocks `component_card` and the Phase 5 composites. Not in scope here.
