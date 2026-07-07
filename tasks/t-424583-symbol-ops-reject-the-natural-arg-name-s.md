---
id: t-424583
title: Symbol ops reject the natural arg name — search_symbol wants `query` (not `name`), list wants `registry` (not `query`), move_file wants `source`/`dest` (not `from`/`to`)
status: done
priority: high
tags:
  - intake
type: dx
complexity: S
area: render
source: dogfood-jul
created: '2026-07-07T20:04:03.405Z'
---
**The single most-recurring dogfood friction (7 inbox entries, ≥6 sessions, 2026-07-04→07).** The op-map/spec describe these ops by their *intent* ("fuzzy-find a symbol **by name**", "does X exist → list") but the canonical arg is different, so the intuitive first call hard-fails and costs a round-trip **every fresh session**.

Confirmed on current `main` (CLI probes, 2026-07-08):
- `search_symbol {name:'Plugin'}` → `bad_args: query: expected string, received undefined; unrecognized 'name'`. (entries 25, 44, 50, 52)
- `list {query:'components'}` → `bad_args: registry: … unrecognized 'query'`. (entries 30, 46)
- `move_file {from,to}` → `bad_args: source/dest … unrecognized 'from','to'`. (entry 9; likely move_symbol too)

The intake normalizer (§7 Postel, `src/ops/intake/`) already maps `symbol→name` etc. but has **no** `name→query` (search_symbol), `query→registry` (list — semantically it should hint `search_symbol` instead), or `from/to→source/dest` (move_file/move_symbol) alias. `list`'s bad_args also doesn't enumerate the valid `registry` values (entries 30/46/389).

Ask: add these aliases to the invisible intake normalizer (disclosed per-call via `Result.intake`), OR — for `list` — when a search-intent key (`query`/`name`) is passed, hint "did you mean search_symbol?" and enumerate valid registries. Sibling of the existing intake tasks t-000155/156/157/158 (same `full-density` area).
