# Spec: the `schema` plugin — generated API types → endpoint cards (Phase 3 closure)

Status: **shipped**. The `schema` plugin reads openapi-typescript `openapi.d.ts` into endpoint
cards; the `list_endpoints` op surfaces them; both are config-gated. See
[`src/plugins/schema/`](../src/plugins/schema/), [`src/ops/list-endpoints.ts`](../src/ops/list-endpoints.ts),
and [`test/differential/schema.test.ts`](../test/differential/schema.test.ts). ARCHITECTURE.md §4
(parser per domain — the schema cell), §5-L2/L3 (plugins + ops), §10 (config), §16 (honesty
harness) frame it.

## 1. Purpose

Complete the non-TS plugin trio — `scss` ✓, `i18n` ✓, **`schema` ✗**. The `schema` plugin reads a
project's **generated API type surface** (OpenAPI → TypeScript) and exposes **endpoint cards**
(method · path · path-params · query · body · response) so an agent can ask "what endpoints exist /
what's the shape of this request" in one call instead of spelunking a 1000-line generated file.
Op: **`list_endpoints`** (and the per-endpoint card it returns chains into `expand_type`).

## 2. The load-bearing decision — DECIDED: target openapi-typescript `openapi.d.ts`

The reader is built to the **real** generated shape, mined (NDA-safe) from the two projects
codemaster runs over. Two shapes dominate, and per §3.4 the common one ships first:

- **backoffice** (`/Users/cody/Dev/backoffice`) — **openapi-typescript** `clients/openApiSchemes/
<service>/openapi.d.ts`: a generated `.d.ts` with `export interface paths { "/users/{id}": {
parameters; get: operations["getUser"]; put?: never; … } }`, `export interface operations {
getUser: { parameters: { query; path; … }; requestBody?; responses: { 200: { content: {
"application/json": components["schemas"]["UserDto"] } } } } }`, and `export interface components
{ schemas: { … } }`. Multiple services, all this shape. **This is the target.** It is the
  ARCHITECTURE §4 "TS-aware reader over the generated schema d.ts" cell.
- **amiro** (`/Users/cody/Dev/amiro`) — `src/api/generated/api.ts`: an **orval-style runtime
  client** (`export const api = { getUser: (p) => m<t.UserDto>({url:`/users/${p.id}`,
method:'GET', …}) }`). A runtime `.ts`, not a `.d.ts`. **Follow-up** (`generator: 'custom'`):
  declared in config but not yet parsed — a foreign/absent shape yields **zero cards honestly,
  never a guess** (§3.4); it is NOT a silent partial.

**The contract** (what the reader reads): iterate `interface paths`; for each path, each HTTP-method
member that is not `?: never` is one endpoint; dereference its `operations["…"]` (or an inline
operation literal) for `parameters.query` / `requestBody` / the lowest-2xx `responses[…]` content.
Each query/body/response is surfaced as a proof-carrying **type reference** (the schema name + a span
anchored at it) — resolution into members is deferred to `expand_type` at that span (§1). An
`operations["X"]` with no matching operation is `unresolved`, never a guessed card. A no-content
(204) response yields no body ref. The reader uses the TS compiler's own parser
(`ts.createSourceFile`, AST only — no checker, so no `deps: ['ts']`).

## 3. Fixed decisions

- **Plugin, not op-level parsing.** A new `plugins/schema/` plugin owns the parse (its own cell,
  §4). It is a **TS-aware reader** using the TS compiler's own parser, never a hand-rolled one.
  As shipped it reads the generated `.d.ts` through `ts.createSourceFile` (AST only — no checker,
  so `deps: []`): the cards carry verbatim type _references_ and member resolution is deferred to
  `expand_type` at the span (§1), so no `ts.Program`/checker is needed in the plugin. (A future
  shape that genuinely needs type resolution would declare `deps: ['ts']`; this one does not.)
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
