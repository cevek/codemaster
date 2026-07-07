---
id: t-000098
title: move_symbol could optionally consolidate PRE-EXISTING dest duplicate imports
status: backlog
priority: low
type: feat
complexity: S
area: ts-refactor
created: '2026-07-08T00:01:37.000Z'
---
**move_symbol could optionally consolidate PRE-EXISTING dest duplicate imports** — deferred. The
guarded fold in `move-to-existing.ts` collapses only the duplication the move ITSELF created (its
`skipModules` set excludes modules dest already had ≥2 statements for), so a same-module split that
ALREADY existed in the dest is left untouched — consolidating it is an unrequested refactor that
expands the diff beyond the moved symbol + its imports, exceeding the op's scoped-edit contract. A
future opt-in "tidy dest imports" could drop the skip-set and fold the whole dest. `feat`·`low`·`cx:S`
