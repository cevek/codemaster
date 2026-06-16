# Task G — Multi-program awareness: usages & dead-code see sibling tsconfigs (test/build programs)

> Self-contained, FAT task. Build on `main`. First: read `CLAUDE.md`, `ARCHITECTURE.md` §3 (trust
> contract), §9 (monorepo = project references, not a flat Program), §19 (project-reference
> redirects), call `status`, READ `src/plugins/ts/ls-host.ts` (the single-tsconfig LS host).

## Why (the biggest standing honesty gap)
The warm LS loads ONE tsconfig (the main `tsconfig.json`). Any symbol used ONLY from a file in a
SEPARATE program — `test/**` under `tsconfig.test.json`, build scripts, `tsconfig.app.json`/
`tsconfig.node.json` — reads as having NO usage. Consequences, all real:
- `find_usages nullWatcher` → `total=1 (decl only)` though `test/helpers/project.ts` imports it
  (feedback friction 2026-06-16T11:25) — an agent reads "dead" and deletes a live symbol.
- `find_unused_exports` would mark such a symbol `certain` dead — we currently paper over it by
  demoting `certain`→`partial` whenever a sibling tsconfig exists (a blunt, repo-wide demotion that
  makes the op partial-only on most repos). `find_unused_scss_classes`/`find_unused_i18n_keys` have
  the same single-program blindness.
- `impact`'s closure stops at the program boundary.

This task replaces the blunt workaround with the real fix: **make the `ts` plugin aware of the
sibling TS programs in the repo** so usages in them are seen.

## Scope — IN
1. Discover the repo's tsconfigs (root + `tsconfig.*.json` + `references`) and load them as
   additional programs in the `ts` plugin — project-reference redirects per §9/§19, each keeping its
   own `compilerOptions` (NOT a flat single-options Program — that would be a lie). LS warms lazily;
   memory/cost stay bounded (the heavy thing is already the LS, §9).
2. `find_usages` / `importers_of` resolve references across ALL loaded programs (a `test/**` usage
   counts). Per-site provenance stays honest; cross-program refs carry their program of origin if it
   aids the agent.
3. `find_unused_exports` (and the scss/i18n dead-code ops) query every program → a symbol used only
   in a test program is NOT reported, and a genuinely-unused one can be `certain` AGAIN (remove the
   sibling-tsconfig blanket demotion I added as a stopgap — it's subsumed here).
4. Freshness/reindex spans all loaded programs (§8): editing a test file invalidates correctly.

## Scope — OUT
- The full monorepo-package story beyond what these ops need (the broader §9 project-references is
  roadmap; do the minimum that makes usages/dead-code honest across the repo's own tsconfigs).
- `process`-mode / kill-on-deadline (spec-daemon-singleton).

## Definition of done
- `fix-and-check` green; full suite 0 fail. Oracle-backed (§16): a fixture repo with `tsconfig.json`
  + `tsconfig.test.json`, a symbol used ONLY from the test program — `find_usages` finds the test
  usage; `find_unused_exports` does NOT report it (and reports a genuinely-dead one as `certain`).
  Cold-program oracle, not golden-only. cold==warm holds across the multi-program state.
- Honesty: never-hang (lazy warm, bounded), wrapped LS calls, freshness across programs. The
  stopgap demotion in `unused-exports.ts` (`hasSiblingTsProject`) is removed, not left dead.
- Layering; files ≤300 lines (the LS host will need splitting). Self-describe any new behavior in
  `status`. Dogfood live (the codemaster repo itself has `tsconfig.test.json` — `nullWatcher` must
  read as USED).

## Files (likely)
`src/plugins/ts/ls-host.ts` (multi-program loading — split as needed) · the `ts` plugin's
usages/importers/references query modules · `src/plugins/ts/unused-exports.ts` (drop the stopgap) ·
freshness/reindex · tests under `test/differential/` (+ a multi-tsconfig repo fixture).

## Parallel-run note
Touches the LS host + usages query — overlaps Task H (usage role/rollup) in the same query area.
If run with H, expect a real merge in the usages modules; otherwise independent. Own worktree off
`main`. Covers: feedback `find_usages blind to test tsconfig` (11:25); plan.md "dead-code ops blind
to a separate test program" + the `find_unused_exports` sibling-tsconfig demotion.
