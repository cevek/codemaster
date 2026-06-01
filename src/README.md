# src — module map & dependency contract

Four hard rules keep this codebase layered for the long run:

1. **Imports flow downward only.** A module may import the layers below it, never one
   above. No upward edges → no cycles → no rot.
2. **`ops/` may import only `plugins/`, `support/`, `format/`, `core/`.** Ops are the public
   unit; they compose plugins, they don't reach below plugins to their internals.
3. **`core/` imports nothing internal.** It is the shared vocabulary every layer speaks.
4. **Plugins form a strict DAG** ([`core/plugin.ts`](core/plugin.ts) — declared `deps`).
   `react-query` may import `ts`'s public API; `ts` must not import `react-query`. The
   `PluginRegistry` enforces this at runtime; ESLint catches it at compile time.

Birds-eye prose: [`../ARCHITECTURE.md`](../ARCHITECTURE.md) §5 (layers) and §15 (tree).

Top → bottom:

| Layer | Module          | Responsibility                                                                                                                                                                  | May import                                                   |
| ----- | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| entry | `bin.ts`        | CLI / process entry; composition root                                                                                                                                           | mcp, daemon, config, core                                    |
| L5    | `mcp/`          | MCP facade: `op` dispatcher · `status` · `batch` (§11)                                                                                                                          | daemon, ops, format, core                                    |
| L4    | `daemon/`       | **orchestrator**: front door (MCP/IPC), `repoId → engine` registry, routing, lifecycle (idle TTL + path-existence eviction), memory governor, `ProjectHost` transport (host.ts) | everything below                                             |
| L3    | `ops/`          | named, parameterized operations — the public unit (`find_usages`, `rename_symbol`, `find_unused_scss_classes`, …). Compose plugins.                                             | **plugins, support, format, core only**                      |
| L2    | `plugins/<id>/` | one domain each — `ts`, `scss`, `i18n`, `schema`, `react`, `react-query`, `tanstack-router`, `zustand`, … Each owns its parser, state, and public API. Strict plugin DAG.       | support, core (+ other plugins **only** per declared `deps`) |
| L1    | `support/`      | shared, non-domain utilities — git, prettier, text-edits, fs (no domain knowledge)                                                                                              | core, config                                                 |
| base  | `format/`       | dense, coded, proof-carrying rendering of `Result<T>`                                                                                                                           | core                                                         |
| base  | `core/`         | pure contracts: `Result`, `Fact`, ids, span, brands, `Plugin` interface, debug                                                                                                  | — (leaf)                                                     |
| base  | `config/`       | `CodemasterConfig` + `defineConfig`                                                                                                                                             | core                                                         |

**Plugins are flat under `plugins/`, not layered.** The DAG between plugins is _runtime_
data (each plugin declares its `deps`), not a directory hierarchy — every plugin lives
directly under `plugins/<id>/` regardless of who depends on whom. Cycles are forbidden
and caught both at compile time (TypeScript imports) and at registry init.

**Plugin internals are private to each plugin.** The TS LS host, VFS, and module-resolve
live inside `plugins/ts/`. postcss-scss lives inside `plugins/scss/`. ast-grep lives
inside the `codemod` op (it does not need a plugin). None of these is a top-level layer
in `src/`.

**Enforcement.** Today the contract is reviewed (see the `architecture-reviewer`
agent), not yet machine-checked; an ESLint import-boundary rule lands once the modules
fill in. Empty dirs carry a `.gitkeep` and fill per the roadmap (ARCHITECTURE §17).
`bin.ts` is the entry / composition root; neither it nor an `index.ts` re-export barrel
is a layer.
