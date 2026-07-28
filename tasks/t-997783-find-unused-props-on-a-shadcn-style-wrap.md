---
id: t-997783
title: find_unused_props on a shadcn-style wrapper drowns one declared prop in ~290 inherited DOM/aria props and trips OUTPUT CAPPED — the sql projection answers correctly, the default view does not
status: done
priority: high
tags:
  - agent-surface
  - dogfood
type: dx
complexity: M
area: render
source: dogfood-jul
created: '2026-07-28T16:10:03.972Z'
---
External report, `amiro/save-only-shared-primitives`. Question: "does anything still pass `marksDirty` to
Switch/Select/Checkbox?" — a dead-prop question about ONE prop the repo itself declares.

```
find_unused_props {component:'Switch', file:'src/components/ui/switch.tsx'}
→ found=288 / declared=297
```

~290 of those are inherited `@types/react` DOM + aria props (`aria-colindextext`, `popoverTargetAction`,
`onCompositionUpdateCapture`, …). The single prop the repo actually declares is buried, and the answer
trips `!! OUTPUT CAPPED` at 19639 chars — so the honest reading is "I did not see the whole list", for a
question whose true answer is one row.

Two things this shows:

1. **The default view answers a different question than the one asked.** For a wrapper that spreads
   `React.ComponentProps<'button'>`, "which declared props are unused" is dominated by props the repo did
   not write and cannot act on. The useful set is props declared IN THIS FILE (or in the repo's own types),
   which is also the only set a dead-prop cleanup can touch.
2. **`sql` already gives the right answer** — `SELECT name, confidence FROM t WHERE name LIKE
'marksDirty%'` returns exactly one row and correctly demotes to `partial` where a call-site is opaque.
   So the capability is there and the default projection is what fails.

Directions (reporter did not pick one, and neither do I): default to repo-declared props with inherited
ones behind a flag; or accept a `prop:` filter so a single-prop question costs one row instead of 297; or
both. Whichever — the honesty channel must survive: `partial` on an opaque call site is the load-bearing
part of the sql answer and cannot be lost in a narrowed view.

Note the shape recurs: t-109741 (prop-aware JSX query) is the same population asking the mirror question
("who PASSES this prop"), and both were driven to grep or sql by the default surface.
