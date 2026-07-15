---
id: t-954279
title: 'Intake hardening: unify `query`↔`name`/`module` across ALL symbol-addressed ops — usage log shows bad_args = 52% of ALL failures (47/91), the single biggest friction'
status: done
priority: high
tags:
  - dogfood
  - intake
type: dx
complexity: M
area: render
source: dogfood-jul
created: '2026-07-15T12:26:38.396Z'
---
## Evidence (codemaster usage/fail.jsonl — 91 failures total)
`bad_args` is **47 of 91 (52%)** — the dominant friction by far. Breakdown after removing the ALREADY-FIXED historical ones:

- **ALREADY FIXED (t-424583, DONE), all pre-2026-07-08 — do NOT re-file:** `search_symbol {name}` (8), `list {query}` (7), `move_file {from,to}` (1). No occurrences after the fix — it holds.
- **`source` flat `{name}`/`{query}`/`{file}`/`{symbols}` → wants `targets:[]` (18)** — the single biggest offender, filed separately as **t-684957** (high). Subsumed here as the same class.
- **THE UNFILED CORE — `query` (and `name`) sent to a name/module-addressed op that wants `name`/`module`/`symbolId`, CONTINUING after the fix:** `find_usages {query}` (07-10, 07-12…), `find_definition {query}` (07-08), `importers_of {query}` (07-10), `impact_type_error {query}` (07-02), `member_usages {query}` (07-14). Agents anchor on `query` after search_symbol/list and carry it to the flat-name ops.

## Ask
Extend the intake normalizer (src/ops/intake/) with a BIDIRECTIONAL symbol-key alias applied to every symbol/module-addressed op: `query` → the op's canonical primary key (`name` for find_usages/find_definition/expand_type/impact_type_error/construction_sites; `module` for importers_of; `targets[]` for source — the t-684957 case; `name`+`member` shape for member_usages). Disclosed via `Result.intake`, canonical schema stays the sole gate. This is the same Postel treatment t-424583 gave the reverse direction (name→query) — extend it the other way and to the remaining ops.

## Minor add-ons (same normalizer, cheap) 
- `max_results` → `limit` (a ToolSearch-habit spelling seen on search_symbol/find_usages).
- nested `filter.pathExclude` scalar → array (the top-level scalar→array coercion doesn't reach nested fields).

## Explicitly NOT filed (bad_args noise, not alias-fixable)
missing required arg (find_unused_props {root} w/o component), invalid enum (feedback bad kind), sql wrong column (self-correcting — error lists columns), `importers_of {name}` (conceptual: it takes a module PATH not a symbol name — a hint, not an alias).

Source: codemaster usage/fail.jsonl oracle pass 2026-07-15. Related: t-424583 (DONE, the reverse alias), t-684957 (source instance, high).
