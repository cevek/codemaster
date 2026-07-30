---
id: t-162650
title: '`construction_sites` renders a SEMANTIC verdict over a program it never scanned: `files=0` proves the sibling program was skipped, yet the answer reads "no literal is assignable" and the remedy blames the caller''s scoping — while `find_usages` fans and discloses on the same question'
status: done
priority: urgent
parent: t-647309
tags:
  - agent-surface
  - dogfood
  - multi-program
type: bug
complexity: M
area: multi-program
source: dogfood-jul
relates:
  - t-071368
  - t-100043
  - t-155425
  - t-228385
  - t-248218
  - t-259465
  - t-288409
  - t-820448
  - t-826059
surface:
  - ops
  - plugins/ts
audience: both
evidence: measured
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

## Second, INDEPENDENT instance — external repo, different mechanism, same false verdict

`/Users/cody/Dev/claude-ui` (pnpm monorepo, per-package tsconfig), filed by an external agent:

```
construction_sites {name:'CreateQueryOptions'}                        → sites (0), scanned: literals=7 files=4
construction_sites {…, pathInclude:['apps/server/**']}                → sites (0), scanned: literals=0 files=0
```

The real — and essentially only — construction site is a CALL-ARGUMENT literal at
`apps/server/src/session.ts:941`: `provider.createQuery({ prompt, cwd, env, canUseTool, mcpServers,
...(this.model ? { model: this.model } : {}) })`, where `provider: AgentProvider` and
`createQuery(opts: CreateQueryOptions)`. Every required field is present and tsc accepts it — the repo
typechecks clean.

Two candidate triggers the reporter names, both worth checking: the literal carries **conditional spread**
elements (`...(cond ? {k:v} : {})`), and the target sits in **call-argument position reached through an
interface method** rather than an initializer or return.

So this is now TWO independent reports of the same op returning a confident `0`:
- the first (internal, `OpContext`) was a scope failure — `files=0` proved the sibling program was never
  scanned;
- this one reports `literals=7 files=4` unscoped, i.e. it DID scan and still found nothing, and then
  `literals=0 files=0` when scoped — the same misleading "widen your pathInclude" remedy on a path where
  widening cannot help.

Raising to urgent: the op's entire purpose is the blast-radius question ("what builds type T"), and it
answers `0` while the answer exists, in two different repos, for two different reasons. A `0` from this op
is currently not evidence of anything, and nothing in the output says so.

Note the overlap with t-228385 (no query for "which call sites pass `{…}` to a factory") — that task asks
for a capability, this one shows the op that already claims that capability failing on exactly the shape.
Whoever picks either should read both.


## Resolution (measured, t-162650 — both instances were ONE mechanism)

**Instance 2 is NOT a second mechanism.** Both reports are the single-program scan. The reporter's
"`literals=7 files=4` ⇒ it DID scan and found nothing" reading is wrong: `files=4` is exactly
`packages/agent-core/src/` (4 files — `frames.ts`, `index.ts`, `messages.ts`, `mock-adapter.gate.ts`),
i.e. the target's OWN package program, not the repo. Proof that the program — not the literal's shape
— is the variable:

```
--root claude-ui              construction_sites {name:'CreateQueryOptions'} → 0   literals=7   files=4
--root claude-ui/apps/server  construction_sites {name:'CreateQueryOptions'} → 1   literals=248 files=11
    apps/server/src/session.ts:958:36 · in ts:q  ← the same literal, found
```

Both triggers the reporter named are DISPROVEN by a hermetic 5-shape fixture (plain call-arg through
an interface method · conditional spread `...(cond ? {model} : {})` in call-arg position · conditional
spread in an initializer · direct call-arg · plain initializer): all 5 are found, `sites=5 literals=9
files=1`. Neither `...(cond ? {} : {})` nor call-argument-through-an-interface-method affects recall.

**The output itself caused the mis-diagnosis.** `scanned: literals=7 files=4` names no program, so a
4-file package scan is indistinguishable from a repo scan — and an external agent built a false theory
about spread syntax on top of it. That is the argument for stating scope POSITIVELY: it is not output
polish, it is what stops a reader constructing a wrong mechanism.

## What the fix does

`plugins/ts/program/scan-fanout.ts` — one cross-program scan driver shared by `construction_sites`
AND `discrimination_sites` (the same bug lived at `discrimination-sites.ts:95`):

- fans over every program CONTAINING the target declaration, **re-resolving T in each** (assignability
  and union type-IDENTITY are invalid across checkers), files claimed first-program-wins so the
  compute surface is the UNION not the sum;
- the no-config FALLBACK primary is excluded as a scan authority when a real-config program contains
  the declaration (t-593802 — its whole-repo DEFAULT-options glob resolves no `paths` and absorbs
  augmentation strays); files it alone covers are reported unscanned, never judged;
- ONE `examined` budget across the whole fan, spent ROUND-ROBIN so a large primary cannot starve a
  sibling to zero, plus a `Deadline` poll at the file boundary → a disclosed `partial` (§19);
- `ops/scan-coverage.ts` — the shared five-cause vocabulary. `programsScanned` states the scope per
  program; emptiness is THREE-state (`!! NOT A VERDICT` for a scan that examined nothing · an explicit
  shortfall for an incomplete scan · the assignability verdict ONLY for a complete union scan); and the
  five shortfall causes carry five separate remedies, each a lever that can change the outcome.
  A spent BUDGET explicitly says "these programs ARE loaded; the shortfall is the budget, NOT a missing
  config" — it deliberately does not ride `lowerBoundNote`'s "index the config", which is inert when the
  program is loaded. A COMPLETE scan names no glob at all (the old note's `widen pathInclude` accusation
  was the t-259465 defect).
- both ops now call `semanticFanoutRefusal` UNCONDITIONALLY (the fan follows the DECLARATION, so a
  `name+file` target fans exactly as a bare name does — a `fanCapable` carve-out would under-guard).
  The guard fires only `in-process`; under `process` isolation it is a no-op by design, so the
  protection is partial, not total.
- `DEFAULT_SCAN_CAP` 1000 → 10000 for `construction_sites`: with the fan the candidate pool doubled,
  and a budget that always truncates makes the answer a permanent lower bound — honest but useless for
  the blast-radius question. The wall-clock guarantee moved to the `Deadline` + the §9 guard.

## Measured cost of the fan (the number requested instead of intuition)

Cold `ts.createProgram` back-to-back on this repo: `tsconfig.json` 432 files / 811 sourceFiles /
620 ms / 336 MB → `tsconfig.test.json` 711 / 1222 / 654 ms / 421 MB. **A second program = +654 ms,
+85 MB RSS** (an upper bound: codemaster's stock-TS programs share one `DocumentRegistry`, so the 432
shared files are not re-parsed). End to end, `construction_sites {name:'OpContext'}`: BEFORE
2.79 s / 696 MB for a TRUNCATED 1-site answer (1000 of 2962); AFTER **3.63 s / 798 MB for a COMPLETE
7010-literal / 713-file scan across both programs**. The fan is not the expensive part.

## Oracle

`{name:'OpContext'}` now returns all 3 `tsc` ground-truth sites — `test/unit/list-dispatch.test.ts:65`,
`test/unit/sql-batch.test.ts:46`, `:69` (the task body's `test/e2e/` paths are stale; the file:line
match) — confirmed by `impact_type_error {edit:{replace:…+probeRequired}}`, whose `introduced (3)` is
exactly that set. It reports 8 sites total, a documented SUPERSET: the op answers assignability, not
flow, so `{...ctxOf(reg), tableRowBound: 10}` at `list-dispatch.test.ts:270/282/295` is a real
`OpContext`-assignable literal that `tsc` does not flag (the spread already carries the new field).

`test/differential/scan-fanout-honesty.test.ts` — 6 tests. The load-bearing one is NEGATIVE, per the
brief: two sibling programs whose compilerOptions DISAGREE (`strict` primary vs a `strict:false`
sibling), where `{ id: null }` is assignable to `{ id: string }` only under the lax options. The
strict-primary-owned file must NOT be reported and the lax-owned one must be — so a fan that reused one
target type across every program's files, or let the lax sibling claim a src file, goes red. Both cold
oracles (`coldAssignableLiterals` per config) assert the two configs genuinely disagree, so the fixture
can discriminate at all.


## Post-review hardening (adversarial review found two further completeness lies in the fix itself)

Both were structurally provable, both invisible to the suite that shipped with the fan:

1. **The fallback-only floor deduped against the POST-path-filter set.** On a no-root repo, any file
   the CALLER's glob excluded was reported as "covered by NO tsconfig" — a false cause (a real
   tsconfig covers it) with an inert remedy ("add a tsconfig"), i.e. the t-259465 defect inside the
   module written to prevent it. It also forced `complete:false` on every scoped call, suppressing the
   verdict the scan had earned. A file is fallback-only iff no RESOLVED fan program CONTAINS it, so
   the dedup set is the PRE-filter one.

2. **A program the per-program `resolve` skipped was invisible in the coverage.** T vacuous /
   non-union under a sibling's own options is a correct SKIP (judging its files against a type it does
   not have would flood), but the skip appeared in no field, so `scanCompleteness` said `complete` and
   the answer printed "the scan was COMPLETE, so this is a verdict" over a fan it had silently
   reduced — the same shape as the original bug, through another door. Now recorded
   (`ScanCoverage.skipped`, a closed reason union), demoting the answer, projected into the scope as
   `programsSkipped`, with its own remedy (neither the budget nor a missing config).

Also: the deadline is polled in the PROGRAM loop, not only the file loop (N checker warms could
outlive the whole budget before it was consulted) — and when the deadline empties the fan entirely the
op no longer answers "T resolves to no checkable type anywhere", a claim about the TARGET it never
established, but an honest `partial{timeout}`. Every shortfall is denominated in FILES: `candidates`
is counted only inside files the walk opened, so after a cut `examined of candidates` reads `0 of 0` —
an exhausted sweep — and `Truncation.totalIsLowerBound` + a `≥` now mark that total as the floor it is
(§12). The three-state gate keys on DID-WE-FINISH, not `examined === 0`: a finished walk over a repo
holding no candidate has established absence and states its verdict, because dressing a complete
answer as partial is the same lie inverted (§3.6). The sql/table surface was still emitting the
REPLACED cap wording beside the new budget note — two vocabularies for one fact on the second surface
— and now forwards the scope and states nothing of its own.

The negative test was strengthened where it did not discriminate the mutation its comment claimed: a
fan that hoisted ONE `resolve` would still LIST the sibling site (judging a lax-program node with the
strict checker yields `any` → a `dynamic` site), so the assertion is now on the site's CONFIDENCE
(`certain` under a correct per-program resolve), not its presence.

Suite: 11 tests across `scan-fanout-honesty` (the fan + the verdict-leak negative),
`scan-coverage-honesty` (the five-cause vocabulary, incl. the deadline cut, a no-tsconfig repo, and a
complete zero-candidate scan) and `scan-narrowing-honesty` (the two defects above). Full `npm test`
1407 pass / 0 fail, `fix-and-check` green.

## Residuals filed, not fixed here

- **t-312854** (UNVERIFIED) — `discrimination_sites` re-resolves T per program for the identity gate
  but derives `covers`/`missing` from the type authority's discriminant domain, so a sibling whose T
  carries a constituent the authority lacks under-reports the exhaustiveness gap. The residual of the
  per-program-resolve invariant, not a separate design question.
- **t-043728** — `TsProgram` exposes no `configPath`, so the fallback-primary exclusion rests on
  display-label string equality (`label !== '(no tsconfig)'`). Sound today and pinned by a behaviour
  test, but a label reword silently re-admits an unsound type authority. Deferred because
  `queryable-program.ts` was held by a concurrent track.
- **t-155425** closed by this change rather than actioned: it asked to reword the "primary program
  only" note, which the fan removed outright.
