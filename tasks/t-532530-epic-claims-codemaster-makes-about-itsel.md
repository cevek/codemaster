---
id: t-532530
title: 'EPIC: claims codemaster makes about ITSELF that nothing mechanically checks — a doc §, a printed remedy, a green assertion that cannot redden, a cited fix-locus'
status: backlog
priority: high
type: infra
complexity: L
area: correctness
source: dogfood-jul
relates:
  - t-259465
  - t-326222
  - t-815425
audience: internal
evidence: measured
created: '2026-07-30T13:11:11.862Z'
---
## The class

codemaster enforces proof-carrying honesty on every answer it gives about a REPO. The claims it makes about
ITSELF — in ARCHITECTURE.md sections, in printed remedies, in its own test assertions, in cited fix-loci —
carry no such enforcement. Each of these was caught by a human/agent reading both sides, and each is
mechanically checkable.

Measured in ONE wave of five parallel tracks:

- **A doc § contradicted the code, three times in three different sections** — §9 claimed the pre-warm peak
  guard is in-process-only while the same track's new task proved it isolation-blind; §9's "Two triggers"
  paragraph claimed a `file` re-pin universally escapes the fan-out guard, false for two ops; §5-L2 claimed
  collapse-by-definition already displaces aliases while the field showed 19 candidates for one declaration.
  Doc-sync review caught all three — by reading, not by a gate.
- **A printed remedy named a lever that cannot move the outcome** (t-259465, urgent) — including codemaster's
  own staleness banner naming `daemon restart` in `--in-process`, where no daemon exists.
- **A green assertion no mutation could redden** — a worker asserted a marker is ABSENT from a surface that
  has no code path to that marker at all. Green under every input, and the test's own header claimed it as
  proof.
- **A cited fix-locus rots silently** (t-326222) — ~40 task bodies carry `fix-locus:` paths that nothing
  repoints.

## Why one epic

The four share a mechanism and therefore a fix shape: **a claim written in prose, about a mechanism owned by
another surface, verified by a reader.** The counter-shape is the same in all four — bind the claim to the
mechanism so drift is a red test rather than a careful reviewer: execute the remedy, project the doc's
universal as rows and join it against the live values, ask whether an absence assertion has any input that
would make it fail, resolve a cited path.

Members are landable independently, and each states its own mechanism. Filed as an epic because fixing them
one at a time re-derives the same insight four times — and because the failure they share is exactly the one
codemaster exists to prevent, aimed inward.

FIRST MEMBER CLOSED (t-160641), and its result reshapes the epic. The absence-assertion half was inventoried mechanically — 618 negative assertions, 136 of this class, **3 vacuous** — so the "half the suite" framing was off by ~50x. Three consequences worth carrying to the other members:

1. **Measure before reforming.** The claimed scale came from two vivid incidents; the measurement turned a suite-wide reform into three lines. Do the same for every remaining member before scoping work from it.
2. **The figure is a SNAPSHOT, not a steady state.** A third sub-shape surfaced during the audit: an assertion that BECOMES vacuous later, in a commit touching only `src/`, when the prose it watched is rewritten. Sub-shapes 1-2 are born with the test and are caught by review of the same diff; this one appears where no reviewer has the test in view and the suite stays green — the signal literally says "nothing to look at". So 3 of 136 is what remains after ordinary prose churn, and the same audit after the next N rewordings will not return zero.
3. **A mechanical guard was considered and REJECTED with reasons** (t-210913, terminal): a `literal-exists-in-src` lint misses sub-shape 1 entirely (the incident that started this had its literal present; the vacuity was in the call graph) and noises over 419 fixture negatives. What the class actually needs is a reachability capability, filed as t-777453 — which is why that op is a member of the addressability epic rather than a nice-to-have.
