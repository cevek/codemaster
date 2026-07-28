# test — layout

Strategy, oracles, and the invariants that gate CI live in
[`../ARCHITECTURE.md`](../ARCHITECTURE.md) §16. This is just the map.

- `helpers/` — `project()` (mount a VFS project from a `{ path: source }` map and run the
  full pipeline hermetically), oracle runners (ripgrep, a cold `ts.Program`), the
  scenario runner, and assert utilities.
- `fixtures/`
  - `_typings/` — shared `.d.ts` stubs (react, tanstack, zustand…) so fixtures need **no
    `npm install`**.
  - `inline/` — helpers for the map → VFS projects used by most unit tests, plus the few
    EXECUTABLE fixtures a runtime oracle both analyses and runs (`condition-runtime-sites.ts`).
  - `repos/` — committed mini-projects for realistic cases (monorepo, scss, i18n,
    dynamic-dispatch, schema) and MCP end-to-end.
  - `scenarios/` — `*.scenario.ts` stateful transcripts (mutate → query → assert).
- `differential/` — the oracle-backed invariants: proof-span validity, per-plugin freshness
  honesty, per-plugin `cold == warm`, edit safety, op-vs-oracle golden, plugin DAG honesty,
  and cross-op envelope-disclosure agreement (§16).
- `unit/` — inline-VFS unit tests (the inner loop: `npm run test:light` = unit + golden).
- `e2e/` — CLI + MCP end-to-end: daemon/bridge lifecycle, sql-over-ops, the response-size matrix.
- `golden/` — dense-output snapshots (never the only assertion for a correctness claim).

Runner: `node:test` + `node:assert`. `npm test` runs all; `test:differential` and
`test:golden` scope to those suites.
