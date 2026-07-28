---
id: t-162650
title: '`construction_sites` renders a SEMANTIC verdict over a program it never scanned: `files=0` proves the sibling program was skipped, yet the answer reads "no literal is assignable" and the remedy blames the caller''s scoping — while `find_usages` fans and discloses on the same question'
status: backlog
priority: high
tags:
  - agent-surface
  - dogfood
type: bug
complexity: M
area: multi-program
source: dogfood-jul
created: '2026-07-28T17:52:38.600Z'
---
Measured by worker 98284777 on main=8caae9c, on the exact question its own track turned on: "I am adding a
required field to `OpContext` — what breaks?"

Ground truth (tsc, both projects): **3** sites — `list-dispatch.test.ts:65`, `sql-batch.test.ts:46`, `:69`.

```
construction_sites {name:'OpContext'}                        → 1  (only engine.ts)
construction_sites {name:'OpContext', pathInclude:['test/**']} → 0, with literals=0 files=0
   note: "no object literal is assignable to interface OpContext in scope … widen pathInclude if you scoped it"
impact_type_error {name:'OpContext', edit:{replace:…}}       → 3  ✓  (§2.8 gate checked 2 programs)
```

**`files=0` is machine-readable proof that nothing was scanned** — the test files live in the sibling
program `tsconfig.test.json`, and `construction_sites` runs on the primary only. Yet the emptiness is
rendered as a SEMANTIC verdict ("no object literal is assignable"), and the remedy accuses the caller of
over-scoping — the one action that cannot possibly help, since widening a path glob does not add a
program. An agent reads proven absence; the truth is an unscanned program.

**The asymmetry inside the tool is what makes this sharp:** `find_usages {name:'OpContext'}` DOES fan
across programs, tags rows (`· prog tsconfig.test.json`) and carries `complete=false` + `!! LOWER BOUND`.
So one op fans and discloses while its neighbour neither fans nor discloses — and the silent one is
precisely the op whose stated purpose is "what object literals build type T", i.e. the blast-radius
question.

Asks, in decreasing order of value:
1. fan `construction_sites` across programs as `find_usages` already does;
2. failing that — print scope POSITIVELY (`programs scanned: …`) plus a `!!` floor for unscanned siblings,
   and **never render 0 as an assignability verdict when `files=0`**: an empty scan and an empty result are
   different facts;
3. fix the remedy: it must not name an action that cannot change the outcome (same rule as the i18n hint
   in t-949045 — never propose the state the call is already in, and never propose a lever that is not
   connected).

Discoverability half, worth its own line: nothing routes "I am adding a required field" to
`impact_type_error`, which answers it correctly. `construction_sites`' summary ("what object literals
build type T") reads as the right tool and then quietly under-answers. See t-248218.

Same family as t-100043 (member_usages returns 1 where 6 consumers exist, type edge severed at the
ops→JsonValue seam) — the honest answer being the most misleading one. This instance is worse in one
respect: the tool holds machine-readable evidence (`files=0`) that its own verdict is unfounded, and
renders the verdict anyway.

Footnote worth keeping: the worker first measured this blast radius with GREP and got it wrong — reported
"one synthetic ctx", reality 3 files. Inline object literals typed structurally contain no `OpContext`
token at all. So grep fails this question by construction, the right op under-answers, and the op that
answers is not discoverable from the question.
