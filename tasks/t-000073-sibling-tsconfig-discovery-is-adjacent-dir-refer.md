---
id: t-000073
title: '**Sibling-tsconfig discovery is adjacent-dir + `references` only'
status: backlog
priority: high
tags:
  - dogfood-jul
type: imp
complexity: L
area: multi-program
created: '2026-07-08T00:01:12.000Z'
---
**Sibling-tsconfig discovery is adjacent-dir + `references` only — real nested discovery (the
STRETCH on the shipped floor)** — discovery loads the primary + adjacent `tsconfig*.json` +
transitive `references`; a nested-package `tsconfig.json` neither beside the primary nor
`references`d isn't loaded as a program. `find_unused_exports` NOW has its honest floor: when any
such undiscovered config exists (`host.undiscoveredProgramLabels()`, a one-time cached repo walk
over `walkFiles`' ignore set), every otherwise-`certain` claim is demoted to `partial` and the
config is NAMED (`demote()` in `unused-exports-classify.ts`) — never a silent false-`certain`-dead
(§3.4). The floor is BLUNT (any undiscovered config demotes ALL otherwise-certain claims; e.g. on
codemaster itself `test/fixtures/repos/kitchensink/tsconfig.json` demotes every dead `src` export
to partial — honest, but coarse). PARTIAL read-path landing: `find_usages` / `importers_of` now do
file-driven NEAREST-config discovery (walk UP from the target file, load that one nested config lazily
for reads), so an in-repo nested config IS loaded and an alias-only usage is found, not floored. The
stretch (remaining): the EAGER all-nested version + the precise (non-blunt) floor + the mutation path.
Original framing — The stretch: load nested configs as real sibling programs (or an
import-graph proxy) so usages are SEEN and only genuinely-undiscovered-reachable exports demote —
precise, not blunt. Risk: slurping hermetic fixture/sub-project configs as siblings (cost + the
reason discovery is conservative today); needs a "shares the import graph" test the cheap blunt
floor avoids. NOT the full monorepo project-reference redirect graph (still scoped OUT). `imp`·`med`·`cx:L` - **Sub-note (post-warm invalidation under-reach, `bug`·`low`).** `ls-host` reindex now invalidates
the discovered/undiscovered memos when a `tsconfig*.json` appears in the changed set, BUT a
`references:[{path:"./base.json"}]` chain through a NON-`tsconfig*.json`-named config is missed:
an edit to `base.json`'s own `references` has basename `base.json`, so `isTsconfigChange` (a
basename match) doesn't fire and a newly-chained config isn't picked up until reconnect. This is
CONSISTENT with — not worse than — the pre-existing discovery blind zone: `findRepoTsconfigs`
(the undiscovered floor) and source-1 sibling discovery already only see `tsconfig*.json` names,
so an arbitrarily-named referenced config was never discovered either. Closed wholesale by the
real-nested-discovery stretch above (which would key invalidation off the resolved config graph,
not basenames). Orthogonally, the trigger OVER-invalidates on any tsconfig EDIT (not just
add/remove) — the safe direction (a redundant lazy recompute, never a stale read), not a bug.

---
**Dogfood 2026-07 (dogfood-jul) — bumped to HIGH: this is the top-recurring monorepo pain, 9 inbox
entries across ≥5 sessions on `claude-ui` (pnpm workspace), `task-manager` (isolated `web/`), and
cross-root queries (entries 3, 10, 14, 34, 37, 38, 39, 40, 42).** The shared symptom: every
`find_usages`/`importers_of`/`find_unused_exports` over a monorepo or an isolated nested package
carries `complete=false` + the `!! LOWER BOUND — N tsconfig(s) NOT loaded` note **even when the
results already contain cross-package hits** (via the `(no tsconfig)` fallback program), so a
deletion-safety / zero-count answer reads as untrustworthy by default and the agent falls back to
grep — the exact thing codemaster exists to remove. Three distinct asks beyond the eager-discovery
stretch:
  1. **Auto-discover workspace member tsconfigs** from `pnpm-workspace.yaml` / `package.json`
     `workspaces` globs (not just adjacent + `references`) — the pnpm/vite app+node split is the
     common shape and every query is floored today. (entries 37, 40, 52-web)
  2. **An in-band load-lever** — the LOWER-BOUND note prescribes "reference the config to recover a
     complete count" but there is no op/flag to do so. Accept a per-call `programs:[paths]` /
     `includePrograms` arg (mirroring `root`) so one call can widen the search. (entries 3, 10, 86)
  3. **Cross-root parity** — a `root:`-targeted sibling repo does NOT load that repo's own
     tsconfigs, so every cross-root `importers_of`/`find_usages` reads incomplete even when it's
     actually complete. Load the target repo's configs like the primary does. (entries 39, 42)

**Residual honesty gap (#38, entry 38, 321) — small, could be its own task:** the symbol-addressed
ops (`find_usages`/`find_definition`/`search_symbol`) that resolve a name to NOTHING in the loaded
programs emit a flat `no symbol named 'X'`, indistinguishable from "genuinely gone", when an
**unloaded nested tsconfig** exists in the tree (the symbol may live there). `find_unused_exports`
already NAMES the undiscovered config; the symbol ops should append the analogous hint
("symbol not found in loaded programs; unloaded nested tsconfig `web/tsconfig.json` exists and is
not indexed"). The file-driven nearest-config discovery may already resolve some of these — verify
whether a `web/`-only symbol now resolves before scoping this residual.
