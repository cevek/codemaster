# src — module map & dependency contract

Three hard rules keep this codebase layered for the long run:

1. **Imports flow downward only.** A module may import the layers below it, never one
   above. No upward edges → no cycles → no rot.
2. **`recipes/` may import nothing below `primitives/`.** Recipes are _compositions of
   the six verbs_ — that constraint is what makes them honest and what lets us measure
   their token savings.
3. **`core/` imports nothing internal.** It is the shared vocabulary every layer speaks.

Birds-eye prose: [`../ARCHITECTURE.md`](../ARCHITECTURE.md) §5 (layers) and §15 (tree).

Top → bottom:

| Layer | Module        | Responsibility                                                                                                                          | May import                                                                        |
| ----- | ------------- | --------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| entry | `bin.ts`      | CLI / process entry; composition root                                                                                                   | mcp, daemon, config, core                                                         |
| L5    | `mcp/`        | MCP facade: self-describing tools, `recipe` dispatcher, `status`                                                                        | daemon, recipes, primitives, format, core                                         |
| L5    | `daemon/`     | **orchestrator**: front door (MCP/IPC), repo→workspace registry, routing, lifecycle, memory governor, `ProjectHost` transport (host.ts) | everything below                                                                  |
| L4    | `recipes/`    | composites (`component_card`, `feature_map`, …)                                                                                         | **primitives, format, core only**                                                 |
| L3    | `primitives/` | the six verbs — search · resolve · refs · trace · list · edit                                                                           | semantic, indexers, refactor, index, format, core (+ `AdapterRegistry` from core) |
| L2    | `refactor/`   | structural refactors (ported front-renamer) + ast-grep codemods                                                                         | foundation, semantic, index, core                                                 |
| L1.5  | `adapters/`   | framework plugins; enrich the graph + self-register at the daemon (never imported by primitives)                                        | index, indexers, foundation, core                                                 |
| L1    | `indexers/`   | structural · scss · i18n · schema — fill the graph                                                                                      | index, foundation, core                                                           |
| L1    | `semantic/`   | live LS query layer (resolve/refs/assignability) — the type oracle                                                                      | foundation, core                                                                  |
| L2    | `index/`      | `GraphStore` (store.ts) — store/update/serve the graph, backend hidden; JSON snapshot; freshness ledger; watcher                        | foundation, core, config                                                          |
| L0    | `foundation/` | vfs · ts-host (long-lived LS) · module-resolve · text-edits · git · prettier                                                            | core, config                                                                      |
| base  | `format/`     | dense, coded, proof-carrying rendering of result types                                                                                  | core                                                                              |
| base  | `core/`       | pure contracts: result envelope, ids, graph model, debug                                                                                | — (leaf)                                                                          |
| base  | `config/`     | `CodemasterConfig` + `defineConfig`                                                                                                     | core                                                                              |

**Enforcement.** Today the contract is reviewed (see the `architecture-reviewer`
agent), not yet machine-checked; an ESLint import-boundary rule lands once the modules
fill in. Empty dirs carry a `.gitkeep` and fill per the roadmap (ARCHITECTURE §17).
`bin.ts` is the entry / composition root and `index.ts` the public re-export barrel —
neither is a layer.
