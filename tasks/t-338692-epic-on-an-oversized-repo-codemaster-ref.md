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

## MEASURED CORRECTION — three premises above are wrong, and the measurement replaces them

Measured on `/Users/cody/Dev/backoffice2` (box 32 GB / 12 cores, node v22.21.1, default V8 limit 4144 MB;
engine built exactly as `engine-child.ts` builds it, flag on the carrying process, RSS via `/usr/bin/time -l`):

- **`find_usages` needs ≈5.2 GB live heap.** A bracket, not a point: flag 5120 (limit 5168) → SIGABRT at
  32.4 s; flag 5632 (limit 5680) → OK, 29.7 s, heapUsed 5197 MB, 11 usages; 6144 → OK, 31.0 s. The default
  4 GB misses by ~1.1 GB.
- **The death is NOT in the program build.** Parse+bind of the same primary costs 839–881 MB / 4.5–5.8 s and
  PASSES on 4096. The ~4.3 GB delta is the checker / findReferences phase. (The "inside the program build"
  reading was inferred from the dump's timestamps and is withdrawn.)
- **`source` does NOT OOM on current main.** file-pin 839 MB / 4.5 s; BARE name with 27 same-named
  declarations (`AppLayout`) 881 MB / 5.8 s — both pass on the default 4 GB. In the field report all four
  calls travelled in ONE batch alongside three `find_usages`: `source` died as a PASSENGER, not on its own
  cost. Member t-229522 therefore stands on latency/heap (839 MB / 4.5 s vs 5.2 GB / ~30 s), on surviving a
  batch whose neighbour burns the heap, and on making `navigate.ts`'s redirect real — never on "otherwise
  unanswerable".
- **Fan-out is NOT the cost, so member 3 of the order above is withdrawn as a MEMORY remedy.** Discovery
  pruning WORKS here: 26 programs constructed (1.7 s, 278 MB RSS), the primary globs 6128 files,
  Σ `fileNames` = 18374, `estimateSearchPeak = {peakFiles: 6128, pruned: true}` — the ~10 checkers do NOT
  sum, and §9's calibration figure for this repo is operative. A bare name, a file-pin in `packages/common`
  and a file-pin in `apps/emr` all cost 5.17–5.23 GB, each answering from ONE type-authority program. Scoping
  the fan cannot bring this repo under 4 GB; the cost is one program's checker.
- §9's ~0.16 MB/file calibration is right for the navto class (measured 0.14 at parse+bind) and simply does
  not describe checker-backed ops (~0.85 MB/file). Not a defect — a scope the docs should state.

### The order that survives the measurement

1. Raise the escalated child's ceiling (t-811950) — the one change that turns an honest OOM into an answer
   here. Note the current `DEFAULT_MAX_OLD_SPACE_MB = 4096` yields limit 4144 = Node's own default, i.e. the
   flag raises NOTHING today.
2. Make the cheap questions cheap (t-229522) — a latency / heap / batch-survival win, honestly stated.
3. Scoped fan-out (t-650055) — NOT a memory remedy on this repo shape. Re-scoped, not dropped: what it
   retains is precision, plus repos where several type-authority programs really are warmed for one question.
