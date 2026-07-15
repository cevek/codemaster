---
id: t-143952
title: New op `list_symbols` — flat, dense, comma-separated catalogue of a repo's symbol NAMES for project-orientation / first-contact browse, grouped per tsconfig, on the fast syntactic no-program engine BY DEFAULT
status: in-progress
priority: high
tags:
  - dogfood
type: feat
complexity: L
area: ts-core
source: dogfood-jul
created: '2026-07-15T12:00:35.701Z'
---
## Why
A first-contact / orientation tool. When an agent enters an unfamiliar repo it currently throws a dozen guessed names at search_symbol "на бум" hoping one hits (and a 0-match dead-ends — see t-517121). Instead, front-load the map: dump WHAT SYMBOLS EXIST so the agent reads the list and picks. Offloads the semantic pick (e.g. "UsageBar" → the real `RateLimitBar`) to the agent — which lexical near-miss ranking fundamentally can't do — by just showing it the names. This is the higher-leverage answer to the weak "did you mean" idea in t-517121.

## Shape (the headline)
Flat, comma-separated, BARE names — `RateLimitBar, UsageInfo, ProgressBar, NavBar, …` — nothing per-line (no `ts:…@file:line:col` decoration), so THOUSANDS fit in one output. Deduped + sorted (alphabetical) so it's scannable. The agent scans → picks a name → does a normal search_symbol/find_definition on it (one cheap follow-up; acceptable trade for the density).

## Engine — SYNTACTIC by default (the critical requirement)
Rides on the no-program syntactic scan (t-515730, `getNamedDeclarations` over parsed git-source): NO LS warm, OOM-safe, fast. First-contact on an unknown/huge monorepo is EXACTLY where the normal name-addressed path OOM-crashes (t-167395), so a discovery tool must not warm programs. A `semantic:true` opt-in could later use the LS for type-verified names, but default = syntactic.

## Grouping by tsconfig + the shared-file caveat
Group the names per tsconfig (orientation: "the app config has these; the test config has these"). CAVEAT the owner flagged: one file can be included by ≥2 configs (`tsconfig.json` + `tsconfig.test.json`, or two workspace members sharing a file) — its symbols must NOT be silently double-counted NOR silently dropped. Recommended v1: assign each file to its NEAREST / most-specific owning config as primary, and annotate a shared file `(shared: also in <config>)`; the flat blob dedups globally. Open design point — resolve before build.

## Flags
- `exportedOnly` — recommend DEFAULT TRUE (public surface first; `all:true` adds locals/internal). Locals are noise for orientation.
- `kind` — filter type / function / component / all.
- `pathInclude` / `pathExclude` — scope to a subtree.
- cap / `limit` — even bare names can't dump 30k; per-group cap with an honest `+N more (narrow by token/path/kind)` marker (§3.4 — never a silent truncation).

## Honesty
Syntactic = names only, NOT type-verified: may include a re-export name; scope is the git source surface under root (t-515730's disclosed limit — outside-root not covered). Every capped group carries the truncation marker. Say plainly it's a syntactic catalogue, not a resolved index.

## Notes
Separate tool (explicit owner ask), NOT a flag on search_symbol. Relates: t-515730 (engine dependency), t-167395 (sidesteps the OOM this class hits), t-517121 (supersedes its near-miss half — being re-scoped to the small preview + file/module-hint), t-262491, and the existing `list` op (registries, not raw symbols). Working name `list_symbols` — final name TBD.

Inbox source: 2026-07-11 (line 232/237) + owner design session 2026-07-15.
