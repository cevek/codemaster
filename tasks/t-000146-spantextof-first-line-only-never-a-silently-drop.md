---
id: t-000146
title: spanTextOf` first-line-only — "never a silently-dropped body" comment overstated
status: backlog
priority: low
type: dx
complexity: S
area: full-density
created: '2026-07-08T00:02:25.000Z'
---
**`spanTextOf` first-line-only — "never a silently-dropped body" comment overstated** — the `symbol`
renderer's full-mode guardrail (`shapes/ts.ts` `declHeader` → `shapes/span-text.ts` `spanTextOf`) keeps
only `text.split('\n')[0]`, so a hypothetical body-bearing `symbol`-tagged row reaching `condense` at
full would lose lines 2..N (same first-line caveat for a multi-line dynamic template in `bareSpan`).
No present consumer triggers it (reaching symbol rows are decl-less; body-bearing forms are
renderSource-intercepted / `verbatim`-disposition). Correct the comment, or route such a future form
through `verbatim`. `dx`·`low`·`cx:S`
