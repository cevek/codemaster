---
id: t-730980
title: 'the concepts worked examples are validated one-by-one: a new `e.g.` line ships unpinned (and 9 local okData copies duplicate one sql assertion helper)'
status: backlog
priority: low
tags:
  - debt
  - tests
type: dx
complexity: S
area: docs
created: '2026-07-28T07:24:51.520Z'
---
Two test-side residuals found while adding the `absence-audit` recipe.

**1. Example validation is per-example, not per-CONCEPTS_LINES.** `test/unit/concepts-example.test.ts`
now has one hand-written test per worked example (the `sql` join, the `absence-audit` anti-join), each
re-finding its line by a substring and re-asserting op/column/args. spec-status-as-the-doc §3 guard #3
wants EVERY example shown to be covered — but a third `e.g.` line added later is caught by nothing.
Wanted: one data-driven test over every `CONCEPTS_LINES` entry containing `e.g.`, extracting the op
name(s) + args + selected columns and validating them against the live catalogue. Needs a small
tolerant parser for the pseudo-JSON in those lines (they are display text, not JSON), which is why it
was not done inline — do it deliberately, not as a fragile regex.

**2. `okData` is copied 9× across test files** (differential ×5, e2e ×4), each with its own return
type; `test/helpers/` has no such helper. A generic `okData<T>(r): T` (precedent:
`test/e2e/cross-repo.test.ts`) would replace all of them. Pre-existing debt, +1 copy from
`test/e2e/sql-absence-audit.test.ts`.
