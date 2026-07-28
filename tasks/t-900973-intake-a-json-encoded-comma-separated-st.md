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

## Пересчёт по fail.jsonl на 2026-07-28 + одна поправка

Класс подтверждён и вырос: **7 записей из 42** (17%) — самый частый единичный класс отказов в логе. Из них **6 — один оп `source`** с одной и той же ошибкой (ts=1784671829625, 1784886507304, 1784923128656, 1785149187507, 1785149187577, 1785250734941).

Видно и различие в диагнозе, полезное при починке: при `symbols` ответ «targets: expected array, received string» (алиас применился, тип не подошёл), при `names` — «unrecognized 'names'» (коллапс `{names:[…]}` не сработал вовсе, потому что значение не массив). То есть чинить надо ДО применения алиасов, а не после.

**Поправка к списку выше:** строка `{"pathInclude":"[\"src/features/…/ChartItemPanel\"]"}` — это `find_missing_i18n_keys` (ts=1784926879048), не `list_endpoints`. Разница существенная: у `find_missing_i18n_keys` аргументов нет вообще (`expected {}`), поэтому коэрция строки его не спасёт — там отдельный пробел в возможностях (оп не умеет сужаться по путям, хотя все соседние i18n-опы умеют). Отдельная строка `list_endpoints {"pathInclude":"/bi/v1/charts"}` (ts=1784925079444) упала по другой причине — плагин `schema` не активен.

Смежное того же класса (естественный вызов, которого оп не принимает): `find_unused_scss_classes {"file":"…/MemberGeneralTab.module.scss"}` (ts=1785094222962) — оп принимает только `pathInclude[]`, а «проверь вот этот файл» самая ожидаемая форма; просится алиас `file`→`pathInclude:[file]`.

## Sibling case: `source` should accept a bare array of SymbolId STRINGS, not only objects

External report, `/Users/cody/Dev/task-manager`: `source {symbols:["ts:…@file:line:col~hash", …]}` →
`bad_args` (expects `targets:[{symbolId}]`).

Two things push the caller to exactly this wrong shape, so it is not carelessness:
1. the SymbolId that `search_symbol` hands back IS a flat string, so passing an array of them is the
   natural next move;
2. the op catalogue line reads "bodies of N symbols at once → source" — the word *symbols* steers straight
   at the wrong field name.

The error message itself is good (it shows the expected shape). The ask is a trivial intake normalization
on top of this task's coercion work: accept `targets: ["ts:…", …]` as sugar for
`targets: [{symbolId:"ts:…"}, …]`, disclosing the rewrite via `Result.intake` per §7 like every other
alias. Same principle as the JSON-string coercion above — the canonical schema stays the sole gate, the
normalizer just recognizes a shape the tool's own output invites.

Worth doing together: both are "the caller passed the thing our own output gave them, in the obvious
container, and we refused".
