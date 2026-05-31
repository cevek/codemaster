# test — layout

Strategy, oracles, and the invariants that gate CI live in
[`../ARCHITECTURE.md`](../ARCHITECTURE.md) §16. This is just the map.

- `helpers/` — `project()` (mount a VFS project from a `{ path: source }` map and run the
  full pipeline hermetically), oracle runners (ripgrep, a cold `ts.Program`), the
  scenario runner, and assert utilities.
- `fixtures/`
  - `_typings/` — shared `.d.ts` stubs (react, tanstack, zustand…) so fixtures need **no
    `npm install`**.
  - `inline/` — helpers for the map → VFS projects used by most unit tests.
  - `repos/` — committed mini-projects for realistic cases (monorepo, scss, i18n,
    dynamic-dispatch, schema) and MCP end-to-end.
  - `scenarios/` — `*.scenario.ts` stateful transcripts (mutate → query → assert).
- `differential/` — the oracle-backed invariants: `search` ⊇ ripgrep, structural⟷semantic
  agreement, proof-span validity, freshness-honesty, `cold == warm`, edit-safety.
- `golden/` — dense-output snapshots (never the only assertion for a correctness claim).

Runner: `node:test` + `node:assert`. `npm test` runs all; `test:differential` and
`test:golden` scope to those suites.
