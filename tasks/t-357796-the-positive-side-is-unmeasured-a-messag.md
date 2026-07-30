---
id: t-357796
title: "The POSITIVE side is unmeasured: a message string pinned by nothing — a mutant erasing it entirely passed 12/12, and 8 of 9 mutants on one commit's lines stayed green"
status: backlog
priority: high
parent: t-532530
type: infra
complexity: L
area: correctness
source: dogfood-jul
relates:
  - t-160641
  - t-259465
audience: internal
evidence: measured
created: '2026-07-30T15:53:56.524Z'
---
## Why this is separate from t-160641

t-160641's inventory measured the NEGATIVE side (absence assertions over rendered prose): 3 vacuous out of
136, i.e. 2%. This is the other half of the same original evidence, and it was never measured because the
inventory looked for negatives while this defect lives on the positive side.

What was observed, in one track, by mutation rather than review:

- a mutant erasing the body of a message-producing branch ENTIRELY — pick-list empty, cause fabricated,
  remedy removed — **passed 12/12** across two syntactic suites plus two others;
- on the lines of one commit, **8 of 9 mutants stayed green** before the author added arms.

So a string can be written, shipped, and covered by a suite that never asserts it exists. Unlike the
negative-side defect, this one has no cheap tell: absence has the "could any input print it here?" question,
presence does not — a positive assertion may exist and still not pin the part that matters (the cause, the
remedy, the count), which is exactly what the erasing mutant proved.

## Scale is UNKNOWN and must not inherit the 2%

Do not read t-160641's figure as covering this. The instrument is different: a mutation table over the
message-producing branches (honesty prose — refusal causes, floor notes, remedies, disclosure claims), not a
grep over assertion forms. Deciding HOW MUCH of that surface to mutate is part of this task, not a
precondition — start with the branches whose text carries a CAUSE or a REMEDY, since those are the ones a
reader acts on and the ones t-259465 already shows can name a lever that does not work.

## What a fix looks like

Not "add asserts everywhere". The useful invariant is narrower: **for a message that states a cause or names
a remedy, at least one test must fail when that clause is removed.** That is checkable per branch, and it is
the property both incidents violated.
