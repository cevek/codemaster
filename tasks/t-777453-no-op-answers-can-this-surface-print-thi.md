---
id: t-777453
title: No op answers 'can this surface print this string?' — the reachability question a honesty audit runs 136 times, and the one grep gets wrong in BOTH directions
status: backlog
priority: high
parent: t-560034
type: feat
complexity: L
area: impact-usages
source: dogfood-jul
relates:
  - t-160641
  - t-259465
  - t-357796
  - t-532530
audience: both
evidence: measured
created: '2026-07-30T16:22:15.053Z'
---
## Measured demand: one question, 136 times, no form for it

An audit of absence assertions over honesty-channel markers had to answer, per assertion: *could this
surface ever print this marker?* There is no op for it, so it ran on grep — and grep erred in BOTH
directions in the same session:

- **false vacuum**: a marker whose literal appears nowhere in `src/` was flagged dead, yet a one-line
  mutation (a soft note that does not exist today) reddens exactly that assertion — the test is REAL;
- **missed vacuum**: `!includes('\n> ')` looked fine by grep, while the producer cannot emit that sequence
  at all, so the assertion was green under every input.

And the original incident is grep-unreachable BY CONSTRUCTION: the literal IS in `src/`; the vacuity lived
in the call graph (`cli/compose.ts` `runOp` never reaches `render-status.ts` `sourceStaleBanner`).

## Two shapes asked for

1. **`reaches {from, to}`** — forward reachability FROM A SITE. Distinct from `impact`, which walks
   references TO a symbol; the question here is "starting at this entry point, is that emitter reachable",
   which is the direction no current op travels.
2. **`string_sources {pattern, within}`** — which expressions can PRODUCE this string. Half of the honesty
   channels are assembled from templates, so a literal search is a lower bound by construction — and the op
   must say so explicitly (a template match is `partial`, never `certain`).

## Why it belongs to the catalogue rather than to the audit

The audit is finished; the question is not. Its recurring users are (a) any test claiming a marker is
absent, (b) any refusal claiming a remedy is printable HERE, (c) any doc claiming a section's universal
holds — i.e. exactly the three surfaces the self-verification epic (t-532530) names. Each of them is a
reachability claim today verified by a reader.

Honest scoping note for whoever builds it: dynamic dispatch and string assembly make a NEGATIVE answer
("this surface cannot print it") the hard half. A `partial` that lists the emitters it DID find, with the
paths it could not resolve named, is already strictly better than grep and does not require solving the
general case.
