# Implementation plan

A checkbox tree of the build, expanded from [ARCHITECTURE.md §17](../ARCHITECTURE.md). Each
`[ ]` is roughly a PR-sized unit. **Definition of done per box:** `npm run fix-and-check`
green · an oracle-backed test (§16) · docs at present state (CONTRIBUTING). Tick a box when
it merges; keep this file present-state — mark what's done, don't narrate history.

Legend: `[x]` done · `[~]` in progress · `[ ]` todo.

## Phase −1 — Scaffold `[x]`

- [x] Architecture & decisions — ARCHITECTURE.md §1–§18
- [x] Module map + import/dependency contract — src/README.md
- [x] Typed contracts — `core/{span,brands,json,ids,result,graph,adapter,debug}`,
      `config/config`, the six verbs + `batch` (`primitives/contracts`)
- [x] Toolchain — strict TS, ESLint (300-line · no-any · no-console · exhaustive switch),
      Prettier, knip, lint-staged + husky, `fix-and-check`
- [x] Docs — CLAUDE.md, CONTRIBUTING.md, test/README.md
- [x] Reviewer agents — architecture / bug / copy-paste (`.claude/agents/`)

## Phase 0 — Foundation (daemon · index · freshness · surface)

- [ ] **Settle the §19 platform decisions first** — `RepoRelPath` canonicalization, non-git
      mtime racy-clean, monorepo project-references, watcher degrade-not-crash, daemon
      singleton, socket path + `Transport` seam, child bootstrap. They gate everything below.

**L0 — port from `front-renamer`, made long-lived:**

- [ ] `foundation/vfs` — in-memory overlay over the real FS (shared by reads + dry-run edits)
- [ ] `foundation/ts-host` — long-lived `LanguageService` over the VFS host; resolve the
      project's own `typescript` + `tsconfig` (`paths`/`baseUrl`), bundled TS as fallback
- [ ] `foundation/{module-resolve, text-edits, git, prettier}`

**Index + freshness:**

- [ ] snapshot codec — per-file shards + `manifest.json`; lazy debounced flush (§5-L2)
- [ ] structural indexer — `ts.createSourceFile` (no checker) → `GraphNode`/`GraphEdge` (§4)
- [ ] graph store — immutable version + atomic swap; per-file `fileVersions` (§8)
- [ ] watcher — chokidar behind an injectable seam; coalesced flush
- [ ] **read-time freshness backstop** — `git HEAD` + `status --porcelain` + file-mtime →
      `FreshnessNote` / reindex-on-read; the never-silent-stale guarantee (§3.5/§8)

**Daemon + surface:**

- [ ] daemon — per-repo registry, IPC server (newline-delimited JSON), injectable clock;
      single-writer + lock-free readers (§8)
- [ ] LS lifecycle — lazy spin-up + LRU eviction (§9)
- [ ] MCP facade — resolve repo from cwd/`root`; deliver guidance via `initialize` (§11)
- [ ] `status` / manifest — adapters, counts, freshness, recipe cheat-sheet (§11)
- [ ] `format/` — dense coded output, `file:line`, truncation, verbosity (§12)
- [ ] `debug/` — namespaced tracing + `AsyncLocalStorage` `req#N` + rotating capped log (§13)
- [ ] zod boundary validation — config load, IPC, MCP args (§7/§10)
- [ ] honesty harness skeleton — `project()` VFS mount, oracle runners (ripgrep, cold
      `Program`), scenario runner (§16)

**Exit:** `status` round-trips agent → MCP → daemon → dense reply; structural graph builds and
survives restart; freshness scenarios (mutate · **add** · `git checkout`) are never silent-stale.

## Phase 1 — `search` (A)

- [ ] `primitives/search` — symbol / text / jsx modes; filters (regex, glob scope, kind,
      jsx tag + prop value, imports type-only, comments)
- [ ] `SymbolId` mint + decode (per-file version)
- [ ] tests — `search --text` ⊇ ripgrep (property); structural⟷semantic agreement; proof-span validity

**Exit:** agent finds symbols / JSX-by-prop-value without grep; invariants 1–3 green.

## Phase 2 — `resolve` + `refs` (B)

- [ ] `semantic/` — live-LS query layer (the §3.1 oracle)
- [ ] `resolve` — expanded type, signature, members (inherited / union-flattened),
      assignability + conflict span
- [ ] `refs` — faceted (call/jsx/import/type/read/write/`impl`); `RefsResult{files,sites?}`;
      per-site `confidence`
- [ ] proof-carrying rebind on stale `SymbolId` (§6) — `rebound{to,proof,confidence}` | `gone`
- [ ] tests — `refs` golden vs LS; `cold == warm`; rebind identity-confidence cases

**Exit:** type/refs answers are live-LS ground truth; structural⟷semantic test stays green.

## Phase 3 — structural `edit` (E)

- [ ] vendor `front-renamer` engine behind `edit` — renameSymbol / moveFile / extractSymbol /
      changeSignature (symbol-anchored, resolved through the LS)
- [ ] dry-run preview (diff + touched + typecheck) → explicit `apply`; git-aware (dirty gate, rollback)
- [ ] resync — `edit` swaps a new graph version + marks dirty; self-correcting on read (§7)
- [ ] tests (git-backed) — dry-run zero-write · `diff(dry)==diff(apply)` · post-apply `tsc`
      clean · rollback byte-exact

**Exit:** edit-safety invariant green; LS/git failure → `ToolFailure`, never a crash.

## Phase 4 — recipes (L4)

- [ ] `recipe` dispatcher tool (§11)
- [ ] `component_card`, `find_unused_props`, `mount_path`, `impact` (type-aware blast radius),
      `why_this_line`
- [ ] tests — each recipe is pure composition of L3; output golden + an oracle

**Exit:** "one call = full answer" recipes; size-to-the-answer output (§12).

## Phase 5 — i18n + scss (C/D)

- [ ] i18n indexer — locale-JSON keys, `t()` usages, missing/orphan; template literals `dynamic`
- [ ] scss indexer — postcss: class defs, usages in consumers, orphans
- [ ] recipes — `i18n_lookup`, `scss_class_diff`
- [ ] config sections wired + zod-validated

## Phase 6 — adapters + `list` (G) · git recipes (I)

- [ ] `AdapterRegistry` + composition-root self-registration; adapters enrich the graph with
      static nodes/edges (§5-L1.5)
- [ ] adapters — tanstack-router, react-query, zustand, forms (autodetect)
- [ ] `list` — proof-carrying `ListEntry`; registries from active adapters
- [ ] git recipes — `recent_changes`, `changed_since_branch`, **`affected`** (changed files → tests)

## Phase 7 — shape codemods (F)

- [ ] ast-grep matcher; JSON codemod recipes (pattern / rewrite / scope); dry-run-first
- [ ] guard — shape-based edits never claim to target a symbol (§7)

## Phase 8 — `trace` data-flow (H)

- [ ] control + data flow — field→render/mutation/cacheKey/http; prop-through-tree;
      mutation→invalidation; type-widening
- [ ] per-hop `confidence` + `provenance`; dynamic hops flagged, never silently bridged
- [ ] heaviest verb; stands on Phases 2 and 6

## Cross-cutting (gates every box, not a phase)

- [ ] `fix-and-check` green · oracle-backed test · no file > 300 lines · no upward import
- [ ] new boundary → zod-validated · new external-tool call → wrapped → `ToolFailure`
- [ ] docs at present state · remove each newly-wired dep from `knip.jsonc` `ignoreDependencies`
