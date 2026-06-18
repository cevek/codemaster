# src — module map & dependency contract

Five hard rules keep this codebase layered for the long run:

1. **Imports flow downward only.** A module may import the layers below it, never one
   above. No upward edges → no cycles → no rot.
2. **`ops/` may import only `plugins/`, `support/`, `common/`, `format/`, `core/`.** Ops
   are the public unit; they compose plugins, they don't reach below plugins to their
   internals.
3. **`core/` imports nothing internal.** It is the shared vocabulary every layer speaks.
4. **`common/` imports only `core/`** — pure logic with no I/O; no `support/` reach-down,
   no plugin reach-up.
5. **Plugins form a strict DAG** ([`core/plugin.ts`](core/plugin.ts) — declared `deps`).
   `react-query` may import `ts`'s public API; `ts` must not import `react-query`. The
   `PluginRegistry` enforces this at runtime (a compile-time ESLint boundary rule lands
   once enough plugins exist to make it pay).

Birds-eye prose: [`../ARCHITECTURE.md`](../ARCHITECTURE.md) §5 (layers) and §15 (tree).

Top → bottom:

| Layer | Module          | Responsibility                                                                                                                                                                                                                                                                                                              | May import                                                           |
| ----- | --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| entry | `bin.ts`        | CLI / process entry; composition root                                                                                                                                                                                                                                                                                       | mcp, daemon, config, core                                            |
| L5    | `mcp/`          | MCP facade: `op` dispatcher · `status` · `batch` (§11)                                                                                                                                                                                                                                                                      | daemon, ops, format, common, core                                    |
| L4    | `daemon/`       | **orchestrator** (front door, `repoId → engine` registry, routing, lifecycle, governor, `ProjectHost` host.ts) + the **singleton**: `daemon-server.ts` (socket daemon), `remote-orchestrator.ts` (bridge forwarder), `connect-or-spawn.ts`, `spawn-daemon.ts`, `protocol.ts`, `orchestrator-api.ts` (spec-daemon-singleton) | everything below                                                     |
| L3    | `ops/`          | named, parameterized operations — the public unit (`find_usages`, `rename_symbol`, `find_unused_scss_classes`, …). Compose plugins.                                                                                                                                                                                         | **plugins, support, common, format, core only**                      |
| L2    | `plugins/<id>/` | one domain each — `ts`, `scss`, `i18n`, `schema`, `react`, `react-query`, `tanstack-router`, `zustand`, … Each owns its parser, state, and public API. Strict plugin DAG.                                                                                                                                                   | support, common, core (+ other plugins **only** per declared `deps`) |
| L1    | `support/`      | external-tool wrappers — `git/`, `prettier/`, `text-edits/`, `fs/`, `sql/`, `transport/` (unix-socket + NDJSON, the daemon's wire) (I/O lives here, nowhere else)                                                                                                                                                           | common, core, config                                                 |
| L0.5  | `common/`       | pure logic over core types — `result/`, `ids/`, `span/`, `confidence/`, `fingerprint/`, `plugin-registry/`, `async/`, `debug-spec/`, `lru/`. No I/O, no timers (Clock seam only)                                                                                                                                            | core                                                                 |
| base  | `format/`       | dense, coded, proof-carrying rendering of `Result<T>`                                                                                                                                                                                                                                                                       | common, core                                                         |
| base  | `core/`         | pure contracts: `Result`, `Fact`, ids, span, brands, `Plugin` interface, debug                                                                                                                                                                                                                                              | — (leaf)                                                             |
| base  | `config/`       | `CodemasterConfig` + `defineConfig`                                                                                                                                                                                                                                                                                         | core                                                                 |

**Plugins are flat under `plugins/`, not layered.** The DAG between plugins is _runtime_
data (each plugin declares its `deps`), not a directory hierarchy — every plugin lives
directly under `plugins/<id>/` regardless of who depends on whom. Cycles are forbidden
and caught at registry init.

**Plugin internals are private to each plugin.** The TS LS host, VFS, and module-resolve
live inside `plugins/ts/`. postcss-scss lives inside `plugins/scss/`. ast-grep lives
inside the `codemod` op (it does not need a plugin). None of these is a top-level layer
in `src/`.

**Internal structure of `common/` and `support/<tool>/` is strict.** Nothing lives at the
root of `common/` or any `support/<tool>/` — every file goes into a topical subfolder,
one concept per folder, one operation per file. **No `utils.ts` / `helpers.ts` /
`misc.ts`**: files are named by their operation (`construct.ts`, `merge.ts`, `parse.ts`),
not by the type of contents. When a subfolder reaches ~5 files, it gets split into
sub-subfolders. This is what stops the "hundred-file junk drawer".

**Enforcement.** Today the contract is reviewed (see the `architecture-reviewer`
agent), not yet machine-checked; an ESLint import-boundary rule lands once the modules
fill in. Empty dirs carry a `.gitkeep` and fill per the roadmap (ARCHITECTURE §17).
`bin.ts` is the entry / composition root (it injects built-in plugins and ops into the
orchestrator via `pluginsFor`/`opsFor`); neither it nor `index.ts` (the public re-export
barrel) is a layer.

**Source imports use explicit `.ts` extensions** (`rewriteRelativeImportExtensions`
rewrites them to `.js` at emit). This lets Node 22+ run src and tests directly via
native type stripping — `npm test` needs no build step (`tsconfig.test.json` typechecks
the tests; `erasableSyntaxOnly` keeps every construct strippable).
