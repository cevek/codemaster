---
id: t-533573
title: 'The heap ceiling only buys ~9.6k files: at the measured ~0.85 MB/file a checker-backed op needs a program built from a NARROWED FILE SET, not a narrowed choice of programs'
status: backlog
priority: high
parent: t-338692
type: feat
complexity: L
area: multi-program
source: dogfood-jul
relates:
  - t-396905
  - t-650055
  - t-811950
  - t-885983
audience: external
evidence: measured
created: '2026-07-30T11:47:44.809Z'
---
## The arithmetic the measurement forces

Measured on backoffice2: a checker-backed `find_usages` costs ≈5.2 GB live heap over a primary that globs
6128 files — **~0.85 MB per file** (against ~0.14 MB/file for parse+bind / the navto class). Raising the
escalated child's ceiling (t-811950) to a clamped 8192 MB therefore buys roughly **9.6k files** and no more.

So the ceiling closes THIS repo (6.1k) and does not close the class:

- ~10k files — marginal, one refactor away from failing again;
- 15k–20k files — unanswerable by any checker-backed op at any ceiling we are willing to grant, because
  granting more means machine-wide swap thrash, which §1 ranks below an honest OOM.

Stating it now is the point: without this task the next field report from a 15k-file repo reads as "the OOM is
back", and the answer would be another round of threshold calibration on a mechanism that cannot reach.

## What actually scales — and how it differs from t-650055

t-650055 (demoted, measured) proposed narrowing WHICH PROGRAMS are warmed. That is not the cost: discovery
pruning already collapses the fan, and every addressing form (bare name, file-pin in `packages/common`,
file-pin in `apps/emr`) cost the same ~5.2 GB inside ONE type-authority program.

The lever that remains is one level down: **build a program over a SUBSET OF FILES** — the external report's
own words, "restricted to a path glob BEFORE the program is built, not as a post-filter". A candidate scope
that is cheap to compute and semantically defensible: the declaring module plus its transitive importers
(`importers_of` already answers that), rather than the tsconfig's whole glob.

## Why this is honest rather than a silent under-report

The answer is then INCOMPLETE BY CONSTRUCTION, and that is acceptable only with a floor that names what was
outside the built set — the reference-graph analogue of the undiscovered-program floor. A partial answer with
a stated floor beats no answer (the reporter's position, and §3.4's vocabulary exists for exactly this).

Two hard requirements, both inherited:

1. **The claim is a NEW one, not the existing config-not-loaded claim.** "Files we did not compile" is not "a
   config we did not index"; different cause, different remedy. Gated by t-885983 (decide the scope once for
   both levels) — do not reuse `target-is-the-only-symbol-of-this-name` or the undiscovered-program entry.
2. **Never on the WRITE path.** A rename computed over a truncated file set would rewrite a subset of real
   references and leave the rest dangling — §7's "a mutation may not ride a gate that did not run" applied to
   the reference set itself. Reads only; mutations keep the full program or refuse.

## Verification, by measurement not reasoning

On backoffice2, for a symbol in `apps/emr`: peak heap + wall-clock of the narrowed build against the 5.2 GB /
~30 s full-program baseline, plus a completeness diff (which reference sites the narrowed set misses) so the
floor's wording is derived from a measured gap rather than asserted.
