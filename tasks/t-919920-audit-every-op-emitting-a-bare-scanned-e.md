---
id: t-919920
title: 'Audit every op emitting a bare scanned:/examined: counter — a numerator with no denominator and no scope reads as proof of completeness, and cost a real false-diagnosis round-trip'
status: done
priority: medium
parent: t-647309
type: imp
complexity: M
area: render
source: dogfood-jul
relates:
  - t-162650
  - t-290877
  - t-467009
audience: external
evidence: measured
created: '2026-07-30T13:12:12.969Z'
---
## The measured harm

An external agent ran `construction_sites {name:'CreateQueryOptions'}` on a pnpm monorepo, got
`sites (0), scanned: literals=7 files=4`, and reported "it DID scan and still found nothing" — then named two
plausible-but-wrong triggers (conditional spread `...(cond ? {k:v} : {})`; call-argument position through an
interface method). Both were later DISPROVEN by a 5-shape hermetic fixture. `files=4` was in fact exactly the
target's own 4-file package (`packages/agent-core/src/`) — one program out of eight.

So the output did not merely under-report: **it supplied the raw material for a wrong theory**, and a second
agent spent a full diagnosis cycle on it.

## The rule

A bare scan counter is a NUMERATOR with no denominator and no scope. `files=4` is indistinguishable from
"files=4 because the repo has 4 files" and from "files=4 of 96 because we walked one program". An agent reads
a number as evidence of work done — so a counter that PROVES the answer is a floor gets read as proof it is
complete.

## The fix shape (already proven on two ops)

State the scope POSITIVELY and per unit of scope:

    programsScanned: ["tsconfig.json: 434 file(s), 2988/2988 candidate(s) checked",
                      "tsconfig.test.json: 279 file(s), 4022/4022"]

Cannot be misread: the denominator and the partition are both in the line. Cost: a few dozen tokens.

## Scope of this task

`construction_sites` / `discrimination_sites` are DONE (t-162650). Audit the remaining ops that emit a bare
`scanned:` / `examined:` block without naming what was scanned. Known adjacent instance:
`plugins/ts/type-widening.ts` `collectWideningSinks` → `trace_type_widening`, which is t-467009's subject and
inherits the same shared coverage vocabulary — so fix it there rather than twice.

The failure mode to keep in view is not the missing fan: it is that **the counter looked like an answer.**


## Audit result

`trace_type_widening` (the known adjacent instance) is CLOSED with t-467009: its step now states
`programsScanned: ["<config>: N forward reference(s), M/N checked"]` — denominator and partition in
the line — on the text AND the sql/table surface, in its own unit (references, not files, since it
enumerates candidates from `getReferencesAtPosition` rather than a file walk).

Sweep of the remaining ops that emit a `scanned:` block (`grep` over `src/ops`, then rendered
output):

- **`find_unused_exports`** — REPRODUCED on current main:
  `node src/bin.ts op find_unused_exports '{"pathInclude":["src/common/iter/**"]}'` →
  `scanned: exports=1 files=1` with nothing saying WHICH programs were searched. It fans across
  programs for candidates dead-in-primary, so the same "one package read as the repo" misreading is
  available here. It already carries the separate undiscovered-config floor, which is a DIFFERENT
  fact and does not supply the denominator. → filed as its own task.
- **`find_unused_i18n_keys`** (`scanned: {keys, usages}`), **`find_unused_scss_classes`**
  (`scanned.modules/classes`), **`css_cascade`** (`scanned: {sheets}`) — same bare shape, UNVERIFIED
  (not reproduced hermetically here; each has its own partial-disclosure machinery — css_cascade
  names its failed sheets and caps confidence — so the residual may be smaller or absent).
