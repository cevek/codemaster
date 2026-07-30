---
id: t-210913
title: 'REJECTED as designed: a mechanical anti-vacuum lint over negative honesty-channel assertions (the marker literal must exist in src) — it misses the case that motivated it'
status: rejected
priority: low
parent: t-532530
type: infra
complexity: S
area: correctness
source: dogfood-jul
audience: internal
evidence: measured
created: '2026-07-30T15:54:30.844Z'
---
## The idea, and why it looks obvious

The cheap half of the vacuous-assertion tell is greppable: for a negative assertion over an honesty
marker (`!!` family, the staleness banner, refusal prose), require that the negated literal exist
somewhere in `src/`. A literal the codebase never produces cannot fail on any input, so the
assertion documents an intention and enforces nothing.

## Why it is not worth building

1. **It misses the expensive case.** The instance that motivated the audit was an absence assertion
   for the staleness banner placed on the CLI `op` output — a surface with no code path to
   `staleBanner`/`renderStatus`. That literal DOES exist in `src/`, so a literal-existence lint
   passes it. Establishing the real property (is the marker's producer reachable from the surface
   under test?) is a module-graph question, and the "surface under test" is not mechanically
   derivable from a test file.

2. **The density is too low to amortize.** Measured over `test/**`: 618 negative assertions, of
   which 136 are over rendered prose (the population of the class), of which 3 are vacuous. A lint
   that must be curated by hand for a 3-in-136 yield is maintenance without leverage.

3. **It is noisy where it is not scoped.** The other 419 negatives assert over fixture content and
   produced code (`no double comma in the merged import`, `doc detached by a blank line`), whose
   literals are correctly absent from `src/`. Excluding them needs a hand-curated marker vocabulary
   that drifts with every new honesty channel.

4. **A muted guard is worse than none.** A check that fires on legitimate assertions gets silenced,
   and a silenced check keeps its claim of coverage — the exact defect this family is about.

## What DOES work, and is already in use

Per-change mutation: break the mechanism the assertion names and require the assertion to redden.
That is the instrument (it caught all three findings AND reversed one false positive that the
literal-grep heuristic had produced), and it belongs in review of a change, not in a standing lint.

## Reopen only if

the density changes materially — e.g. a later sweep finds vacuous negatives at a rate where a
curated vocabulary pays for itself — or if a cheap reachability oracle (surface → producer module)
becomes available, which is the half that would have caught the originating case.
