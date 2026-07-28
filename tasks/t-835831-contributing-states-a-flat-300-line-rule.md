---
id: t-835831
title: CONTRIBUTING states a flat ≤300-line rule but `max-lines` is configured on `src` only — a 345-line test file passes the gate while contradicting the written rule
status: backlog
priority: low
tags:
  - docs
  - dogfood
type: infra
complexity: S
area: correctness
source: dogfood-jul
relates:
  - t-000058
  - t-000166
  - t-035990
  - t-500947
surface:
  - docs
  - test
audience: internal
evidence: measured
created: '2026-07-28T17:49:18.009Z'
---
Reported proactively by worker 98284777 so it would not surface as a surprise at merge.

`CONTRIBUTING.md` states the rule without qualification — "≤ 300 lines of real code per file. Over the
line? Split by responsibility — never raise the cap." The eslint `max-lines` rule is configured for `src`
only, so `test/unit/process-host.test.ts` sits at 345 lines with a green gate.

Neither side is obviously wrong: a table-driven test that pins 133 op×shape pairs is not improved by
splitting, and the src cap exists for maintainability of production modules. What is wrong is that the
written rule and the enforced rule differ silently, so an agent reading CONTRIBUTING either over-splits a
test for no reason or discovers the discrepancy by accident.

Fix is a decision, not code: either extend `max-lines` to `test/` and split what exceeds it, or state in
CONTRIBUTING that the cap applies to `src/**` and say why tests are exempt (fixtures and matrices grow
with coverage, and splitting a matrix hurts discrimination). Second option is likely right — several tracks
this week added deliberately large matrices precisely because a wider matrix catches more mutants.

Same class as the doc-vs-code drift this session kept finding, one level over: here the doc drifts from
the TOOLING rather than from the code.
