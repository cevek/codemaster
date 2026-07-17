---
id: t-411303
title: Audit remaining LS fan-out ops (member_usages / affected / trace_*) for the semantic-fanout size guard
status: done
priority: medium
parent: t-031282
tags:
  - dogfood
  - multi-program
  - platform
type: feat
complexity: M
area: platform
created: '2026-07-17T01:37:37.860Z'
---
Follow-up to t-679091 (which guarded the pinned fan-out ops: `find_usages` / `impact` / `importers_of` unconditionally + `find_definition` bare-name). The same in-process OOM surface — warming the LS and fanning references/imports/graph-walks across every program — exists in other ops NOT covered by that track. Audit and, where they fan, apply the SAME `semanticFanoutRefusal` guard (`src/ops/guard/semantic-fanout-guard.ts`): in-process + over `ts.searchWarmMaxFiles` + no `force` → honest ToolFailure redirect to `daemon.isolation:'process'`, at the TOP of run() before any resolve/warm.

## Candidates to audit (confirm each actually fans the LS across programs before guarding — don't false-refuse a cheap op)
- `member_usages` — member-access fan-out.
- `affected` — import-graph walk (support/git + ts import graph) → changed files to tests; walks the graph, may warm/fan.
- `trace_*` family (`trace_invalidation`, `trace_prop_through_tree`, `trace_field_to_render`, `trace_type_widening`) — walk plugin-to-plugin per hop, warm the LS, and chain find_usages-like steps.
- Any other op that calls `ts.findUsages` / `findReferencesAcross` / `programsContaining` / a repo-wide navto (`searchSymbols`) on an unbounded target.

## Method
Grep the ops for the fan-out seams (`findReferencesAcross`, `programsContaining`, `searchSymbols`, `findUsages`), classify cheap (single-program-exact resolve) vs fan-out, guard the fan-out ones, add `force`, and a discriminating test per op (refuse in-process-over-threshold; not refused for a cheap addressing path / process-mode / force / below-threshold — the t-679091 test shape). Reuse the same estimator + threshold (one knob).

## Not silently dropped (§3.4)
Filed explicitly because t-679091 pinned its scope to 4 ops; this closes the "other fan-out ops" class so it isn't a silent gap. Raised by the t-679091 worker per the manager's Q2 sign-off.
