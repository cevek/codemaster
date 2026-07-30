---
id: t-160641
title: Absence assertions that cannot fail — MEASURED at 3 of 136 honesty-channel negatives, not the half this task first claimed
status: backlog
priority: medium
parent: t-532530
type: infra
complexity: M
area: correctness
source: dogfood-jul
relates:
  - t-259465
audience: internal
evidence: measured
created: '2026-07-30T13:11:30.371Z'
---
## What happened, self-reported by the author

Building the self-staleness banner fix, a worker wrote what looked like the strongest possible oracle:
extract the command out of the rendered banner text and EXECUTE it as a subprocess. **That half is real** —
corrupting the script path in the banner turns it red.

But on the SAME subprocess output it also asserted the banner does NOT appear, meaning to prove the banner's
own claim that a one-shot is fresh by construction. A reviewer showed the assertion is vacuous: the CLI `op`
path (`bin.ts` → `cli/compose.ts` `runOp` → emit) never reaches `staleBanner` or `renderStatus` at all, so
the string cannot appear on that surface whether the tool is fresh, stale, or broken. Green under every
mutation — and the file header claimed it as proof.

## Why this is a class, not one slip

codemaster's honesty channels are almost all PROSE printed by one surface about a mechanism owned by another:
refusal redirects (`ops/guard/navigate.ts`), the fan-out guard's remedy tail, floor notes, the staleness
banner. The natural test for each is "assert the string is / is not there", and **the absence arm is
structurally unable to fail whenever the surface under test has no code path to that string** — absence is
the default state of every such surface.

## The tell is cheap and mechanical

For any `doesNotMatch(output, /marker/)`: **ask whether ANY input makes that marker appear on THAT surface.**
If none does, the test documents an intention and enforces nothing. This is lintable in the common shape
(a negative assertion whose marker literal appears in no module reachable from the surface under test) and
reviewable in the rest.

## Two shapes that survived review — reuse these

1. **Extract the lever out of the rendered text and run it.** The oracle is the mechanism (subprocess exit +
   its output), never a second copy of the expected wording — and it also catches the drift case where a
   remedy is reworded into something un-runnable.
2. **Put the absence arm on the surface that DOES render the marker** (here `codemaster status`, which calls
   `renderStatus`), so the absence is produced by the staleness tracker computing `false`, not by the string
   being unreachable.

## Scope

Audit the existing negative assertions over honesty-channel markers (refusal prose, floor notes, banners,
guard tails) against the tell above; convert or delete the vacuous ones; where a positive-surface arm exists,
move the absence there. A deleted vacuous test is a gain — it removes a false claim of coverage.

## Second independent instance in the SAME wave — raising to urgent

Two workers, two tracks, two different mechanisms, one property: **assertions that cannot fail.**

- **Track D (the banner):** an absence assertion on a surface with no code path to the marker — green under
  every input, and the file header claimed it as proof. (The case above.)
- **Track B (no-program `source`), found by mutation testing rather than by review:** on one commit's own
  lines, **8 of 9 mutants stayed green**; separately, a mutant that ERASED AN ENTIRE MESSAGE STRING passed
  12/12. Two of that track's five review rounds produced BLOCKs located *in the tests* — the strings the
  author had written were pinned by nothing.

So the defect is not "one worker wrote one weak test". Within a single wave, a suite that looks well-covered
turned out to be unable to redden on two unrelated surfaces, and the two were found by different means (an
adversarial reviewer; a mutation table). Whatever fraction of the suite this is, it is not small enough to
treat as anecdote — and every green run in the meantime carries a claim of coverage it does not hold.

## What raising the priority buys

The mechanical tell (below) is cheap and applies today; the mutation table is the general instrument and is
already being run by hand in tracks. Both should exist as something a change can be checked against, before
more honesty-channel prose accumulates assertions that document intent and enforce nothing.

## MEASURED — the scale claimed above is WRONG, and the class splits in two

A full inventory of `test/**` (brace-balanced extraction, not line grep) over `doesNotMatch` / `ok(!…)` /
`notEqual|notStrictEqual|notDeepEqual` / `equal(x.includes(…), false)`:

- **618** negative assertions total, in 120 files;
- **136** are this class (negatives whose subject is RENDERED PROSE — msg / note / rendered / stdout / hint /
  terse / full), the rest are negatives over data fields or fixture content;
- of those 136: **133 hold, 3 lines in 2 files are vacuous.**

So the title's "half" is off by ~50×, and the honest figure is 2%. Corrected rather than quietly dropped:
a task overstating its own scale is the same lie about volume this repo files against everything else.

## What the measurement did NOT cover — and why the class still exists

The urgent priority rested on TWO pieces of evidence. Only the first is measured here.

1. **Absence assertions** (this inventory) — measured, small, closed by the accompanying track.
2. **A message string pinned by nothing on the POSITIVE side** — a mutant erasing an entire message passed
   12/12 across four suites; 8 of 9 mutants on one commit's own lines stayed green. **Not covered by this
   map**: it looked for negatives, and that defect lives on the positive side. Its real scale is UNKNOWN,
   and a full mutation table over the suite is a different instrument, not an extension of this task.

Filed as its own task so the unmeasured half does not inherit a figure that was measured for the other one.

## The tell, corrected

The strict form ("is there an INPUT that makes the marker appear?") cuts too wide — it would condemn the
whole density/render-compact layer, where the renderer legitimately decides NOT to print and a one-line
mutation of the renderer reddens the test. The working definition:

> **Vacuous = the marker appears under NO input AND under no plausible one-step mutation of the producer.**

Three buckets, only the third is a defect: **REAL** (absence produced by computation — another input on the
same surface prints it), **GUARD** (input does not toggle it, but a one-line mutation of the surface's own
code does), **VACUOUS** (neither — the literal exists nowhere, or the marker does not correspond to the
mechanism the test names).

A worked reversal, worth keeping: one candidate flagged vacuous by grep (`expand-type.test.ts:347`,
`!/more member/`) turned out REAL — adding a soft note that does not exist today reddens exactly that line,
and the neighbouring `deepEqual` does not cover it. Grep proposes; mutation decides.
