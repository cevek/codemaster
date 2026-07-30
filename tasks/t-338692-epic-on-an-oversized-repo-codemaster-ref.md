---
id: t-338692
title: 'EPIC: on an oversized repo codemaster refuses instead of answering — every guard/isolation win made the FAILURE more accurate, none made an ANSWER possible'
status: backlog
priority: high
type: imp
complexity: L
area: platform
source: dogfood-jul
relates:
  - t-000524
  - t-031282
  - t-163532
  - t-187018
  - t-396905
  - t-408918
  - t-544207
  - t-735577
  - t-820448
  - t-847874
  - t-972931
  - t-980509
audience: external
evidence: measured
created: '2026-07-30T11:21:37.767Z'
---
## The reframe

~15 tracked defects concern the OOM class, and they split into exactly two mechanisms:

- **predict-and-refuse** — the pre-warm size guard, the semantic fan-out guard, their coverage gaps and
  threshold calibration;
- **isolate-and-die-honestly** — process-mode escalation, the SIGABRT→`ToolFailure{oom}` translation, the
  stderr relay, the refusal-redirect table.

Both defend §1 (never hang) and §3 (never lie), and both WORK: the daemon survives, the answer is honest,
other workspaces are untouched. And capability on such a repo is ZERO — on
`/Users/cody/Dev/backoffice2` (6101 src files) every reference question falls back to grep, which is what
the tool exists to replace. Each further win in either mechanism is a more accurate refusal.

This epic holds the members that make an ANSWER possible. The guard/isolation work stays under
`t-031282` (§1 never-hang hardening) where it belongs — as the backstop for what is genuinely too big,
not as the outcome.

## The measurement the members rest on

Relayed child fatal dump, `~/.codemaster/backoffice2-088897ca/child-stderr.log`, three separate pids:

    30607 ms: Mark-Compact 4048.0 (4140.6) -> 4033.6 (4142.3) MB … allocation failure
    FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory

Ceiling ≈ **4144 MB = Node's own default**; death at 25–31 s, i.e. inside the PROGRAM BUILD, not the query.
Identical when addressed by an exact `symbolId`, and identical for `source` ("print these two
declarations"). So the cost is the whole-program warm, the box had RAM to spare, and nothing raised the
ceiling.

## Order (each member states its own verification)

1. Raise the escalated child's ceiling — the escalation already measured the repo as oversized.
2. Make the cheap questions cheap: a no-program `source`, since the syntactic surface already exists.
3. Scope the fan BEFORE the program is built, and answer with a stated floor.

## The claim-vocabulary trap every member shares

"A program we loaded and chose not to SEARCH" is NOT the existing undiscovered-config claim ("a config we
did not LOAD — index it"): different cause, different remedy. Folding them into one `UnsafeClaim` entry is
the two-authorities-on-one-question failure (§3.4 closed union). The scope decision is tracked separately
and gates any member that renders a floor.
