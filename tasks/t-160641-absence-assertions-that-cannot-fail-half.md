---
id: t-160641
title: "Absence assertions that cannot fail: half of codemaster's honesty-channel tests assert a marker is missing from a surface with no code path to it — green under every mutation, and the tell is mechanical"
status: backlog
priority: urgent
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
