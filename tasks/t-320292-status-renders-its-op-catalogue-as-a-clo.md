---
id: t-320292
title: status renders its op catalogue as a closed list while the tool-list advertises more, and neither surface says the difference exists
status: backlog
priority: high
tags:
  - agent-surface
  - dogfood
  - honesty
type: bug
complexity: S
area: platform
source: dogfood-inbox-aug
surface:
  - format
  - mcp
audience: external
evidence: repro
created: '2026-08-08T12:29:46.456Z'
---
On a repo where some plugins are inactive, `status` prints `ops (28)` and the MCP tool-list for the same connection advertises 36. The eight-op difference (`find_missing_i18n_keys`, `find_unused_i18n_keys`, `i18n_lookup`, `list_endpoints`, `invalidations_for`, `trace_invalidation`, `trace_prop_through_tree`, `trace_field_to_render` on this repo) is by design per §11 — the tool-list is the static union, an inactive op answers `unavailable`. The defect is that NEITHER surface states it.

`status` is the surface the server instructions call the per-repo deep dive, and it renders a FILTERED catalogue with no marker naming the filter. That is the same completeness rule the tool enforces everywhere else, inverted: a capped result set must report `{shown, total}`, a narrowed scan must state what it did not walk — but the op catalogue, which IS a result set produced by a filter, presents the remainder as the whole.

Read from the other side it costs the reader the opposite way: an agent holding the tool-list has no way to know that eight of its tools will decline before spending a call on each.

## Why this is not cosmetic

The two readings of a missing op imply OPPOSITE actions, and nothing lets the reader choose between them:

- the op was REMOVED → any report mentioning it is stale, discard it;
- the op is INACTIVE HERE → the report is live, and the op works where its plugin is.

Established while triaging a feedback inbox holding many i18n op reports on this repo: `status` could not distinguish "`find_missing_i18n_keys` no longer exists" from "its plugin is not detected here", and the whole i18n cluster's disposition turned on that.

## Remedy (keeps the terse default)

One line under the catalogue:

    +8 ops inactive here (plugins i18n, schema, react-query not detected) — find_missing_i18n_keys, …

Names the filter, names what it removed, and stays within the terse render. The names matter more than the count: a reader looking for a specific op needs to find it in the inactive list, not infer its absence from arithmetic.

## Свидетельство

2026-08-08, this repo, `status` with `plugins: ts@0.1.0 · scss@0.1.0`. `status` reports `ops (28)`; the connection's tool-list carries the 36-name union quoted above.
