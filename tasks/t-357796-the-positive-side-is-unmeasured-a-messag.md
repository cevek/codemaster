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

## A fourth sub-shape: coverage the seam FABRICATED (t-810757)

The three known sub-shapes are all a MISSING link to the mechanism — a surface no input can reach, a marker
that does not track the property, an assertion that outlived its prose. This one is a FALSE link, and it is
worse because it looks like exemplary coverage: a seam, an isolated unit, a discriminating assertion, green.

Address: `test/unit/syntactic-surface-fallback.test.ts`, the arm formerly titled *"a walk that FAILS fails the
surface — never an empty catalogue that reads as an empty repo"*. It drove the injected `WalkRunner` with
`fail({tool:'fs', …})` and asserted the surface failed. It did. But `support/fs/walk.ts` **never returns a
bare failure**: every path returns `ok(files)` or `partial(files, …)`, so an unreadable root arrives as
`partial([], …)`. The production check was `if (walked.data === undefined)`, which `partial` passes straight
through — so the shipped system answered `names: 0` for a directory nobody could read, a proven-looking
absence, while the arm that existed to forbid exactly that was green. The mutant that should have caught it
could not: removing the fail branch changed nothing the test could see, because the test was the only thing
reaching it.

How it was noticed: NOT by mutation and not by reading the test. Two independent reviewers compared the
docstring's claim against `walkFiles`'s actual return contract and found the branch unreachable. The tell is
therefore a question about the SEAM, not about the assertion: **can the real producer behind this seam emit
the value I am injecting?** A seam is a fault INJECTOR, and the faults it may inject are exactly the ones its
production implementation can produce; anything else is a fixture for a system that does not exist.

Why it belongs to this task rather than t-160641: the assertion here is POSITIVE (`res.ok === false` plus the
cause substrings) and it is not vacuous in the negative-side sense — it can fail, and it did fail under
mutation. The defect is that what it can fail about is unreachable. So the instrument this task builds needs
a second column beside "does a mutant on this branch turn it red": **is this branch reachable from the real
producer at all** — a branch that is not is either dead code to delete or a contract the producer must start
honouring, and both are findings.

Both arms now use the shape the real walk produces (`partial([], …)`), and the discriminating pair is
explicit: reached-nothing FAILS, clean-walk-finds-nothing stays an honest empty.
