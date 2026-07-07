---
id: t-019044
title: Warm index picks up nested `.claude/worktrees/**` checkouts and `dist/`/build output — every encloser doubles, minified bundles surface as symbols
status: done
priority: high
type: bug
complexity: M
area: multi-program
source: dogfood-jul
created: '2026-07-07T20:04:15.412Z'
---
**Recurring on `claude-ui` (4 inbox entries: 33, 43, 51, + bug 35), 2026-07-06→07.** `find_usages`/`importers_of`/`search_symbol` return every encloser **twice** — once at the real path (`apps/web/src/…/DraftChatView.tsx`) and once at a mirrored copy under `.claude/worktrees/chat-model/apps/web/…` (same content-hash) — roughly doubling the blast radius and making a deletion-safety / true-usage count hard to read. Separately, `search_symbol` surfaces **minified `apps/web/dist/assets/index-*.js`** symbols (mangled class names `qi`, useless spans).

Environment confirmed 2026-07-08: `/Users/cody/Dev/claude-ui/.claude/worktrees` and `.../apps/web/dist` both exist. **NOT reproduced on codemaster itself** (its `.claude/worktrees` is empty *and* gitignored → 0 pollution) — tagged UNVERIFIED for that reason.

**Scoping caveat (mechanism):** the doubling is likely **tsconfig-include-glob-driven, not gitignore-driven** — a nested worktree's files match the primary/app `include: ["apps/**", "src/**"]` globs regardless of `.gitignore`, so the TS program picks them up even though `walkFiles`' built-in ignore set (§10) lists `.claude`. That changes the fix: the exclusion must apply to the **TS program file set** (nested-`.git` worktree dirs + `dist`/build output), not just the non-git plugins' walk. Verify which layer includes them before scoping.

Sub-bug (entry 35, UNVERIFIED): `find_usages {filter:{pathExclude:['.claude/worktrees']}}` reportedly returned a byte-identical result to the unfiltered call — i.e. `pathExclude` not applied to the **enclosers rollup** (only leaf refs?), or the segment substring didn't match. Repro on a polluted repo (claude-ui) and confirm/deny.

Ask: default-exclude nested-`.git` worktree checkouts and build output (`dist`/`build`) from the warm program set (or expose a stable ignore config), and honor `pathExclude` on the enclosers rollup.
