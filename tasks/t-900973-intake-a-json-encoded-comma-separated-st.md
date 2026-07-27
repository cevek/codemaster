---
id: t-900973
title: 'intake: a JSON-encoded / comma-separated STRING on an array field hard-fails (bad_args) — coerce it like the scalar→array rule'
status: backlog
priority: medium
tags:
  - dogfood
  - intake
type: dx
complexity: S
area: render
source: dogfood-jul
created: '2026-07-27T22:18:57.286Z'
---
The §7 intake normalizer coerces a bare SCALAR into a one-element array on a pure-array field, but not a
string that CONTAINS a list. Agents routinely send one, and every such call dies at the canonical gate.

Observed in `~/.codemaster/usage/fail.jsonl` (5 distinct calls, 3 ops):

- `source  {"symbols":"[\"TreatmentTypeSelector\", \"FilterableSelect\"]"}`
  → `bad_args: targets: Invalid input: expected array, received string`
- `source  {"symbols":"[\"ts:TimeSlotPicker@…\"]"}` (same shape, SymbolIds)
- `source  {"names":"[\"MODEL_OPTIONS\"]"}`
- `source  {"names":"useClinicalSignFlow,OpenEncounterButton"}` (comma form)
- `list_endpoints {"pathInclude":"[\"src/features/…/ChartItemPanel\"]"}`

Note the second-order damage on `source`: the string is ALSO ≤20-check'd as a char list, so the error
piles on a bogus "at most 20 targets per call" beside the type error — actively misleading.

Fix (in `src/ops/intake/`, driven off `arrayFieldsOf`/`nestedArrayFieldsOf` so it applies uniformly):
on a pure-array field receiving a `string`, try `JSON.parse` → accept only if the result is an array of
the element type; else, if it contains a comma, split+trim. Disclose the rewrite in `Result.intake`
(`interpreted: symbols(json-string)→targets`) per §7 — never silently. Anything else still hard-fails.

Done: oracle-backed unit test per form (json-string, comma-string, already-array untouched, a genuinely
scalar-typed field untouched), and the `source` ≤20 cap evaluated only AFTER coercion.
