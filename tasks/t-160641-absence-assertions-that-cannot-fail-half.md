---
id: t-160641
title: Absence assertions that cannot fail — MEASURED at 3 of 136 honesty-channel negatives, not the half this task first claimed
status: done
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


## The third sub-shape: an assertion that BECOMES vacuous, in someone else's commit

The two sub-shapes above are born with the test and are catchable in review of the diff that adds them —
an absence arm on a surface with no code path to the marker, and a marker that does not track the property
the test names. The third is not:

**an assertion whose prose is real when written, and whose producer is later reworded.** The literal in the
test then matches nothing, silently: the assertion goes green-forever, its file header keeps claiming the
property, and the commit that caused it touched only `src/` — no reviewer of that diff had the test in
front of them, and the suite stayed green, which is exactly the signal that says "nothing to look at".

Measured instance: `test/differential/scan-coverage-honesty.test.ts` asserted the absence of
`were walked across` in the deadline-cut scan note. `ops/scan-coverage.ts` emitted that phrasing when the
arm was written; the note was later rewritten to the file-denominated form (`after walking N of M in-scope
file(s)`), and the assertion outlived its own subject.

**Why this changes the remedy.** A one-time inventory closes sub-shapes 1 and 2 and does not close this one:
it accrues, at the rate the honesty prose is reworded, in commits that are not about tests. So the 3-of-136
figure is a snapshot, not a steady state — it is the residue after this repo's ordinary rewording, and the
same audit re-run after N more prose changes will not find zero. That is the argument for a periodic pass
(cheap: the extraction is scripted, the verdict is per-item), and the argument against reading the small
number as "the class is closed".

**What a mechanical check would need.** Not literal-exists-in-`src` — that misses sub-shape 1 (the banner
literal does exist) and mis-fires on fixture-content negatives. The two capabilities that would answer it
are call-graph reachability from a call SITE, and "which expressions can produce a string matching this
pattern" with template assembly reported as an explicit lower bound (half the honesty channels are
template-built, which is precisely where a grep verdict is wrong in both directions). Filed as codemaster
feedback; until such an op exists, mutation of the producer is the instrument, and it costs minutes per
assertion rather than one call.
