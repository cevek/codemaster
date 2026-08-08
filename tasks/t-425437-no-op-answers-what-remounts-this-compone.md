---
id: t-425437
title: No op answers "what REMOUNTS this component" — reconciliation identity (same-position type switch, key churn, conditional mount) is mechanically decidable from JSX and is today answered by hand, wrongly in both directions
status: backlog
priority: high
tags:
  - agent-surface
  - dogfood
  - react
type: feat
complexity: L
area: framework
source: dogfood-inbox-aug
relates:
  - t-045024
audience: external
evidence: reported
created: '2026-08-08T12:02:42.552Z'
---
Whether a piece of local state survives depends on React RECONCILIATION IDENTITY, not on prop flow, and no
op models it. `find_usages {role:'jsx'}` gives call sites; `trace_prop_through_tree` walks props DOWN.
Neither answers "does this node keep its identity across this state change" — yet the facts that decide it
are purely structural and mechanically derivable from the JSX plus the render graph.

Shape: `remount_sites {name:'X'}` reporting, for each path from a call site up to a stable root:

- **same-position type switches** — two branches of one parent rendering DIFFERENT component types at the
  same child index (the case that actually fires in practice, and the one that is non-local);
- **key churn** — an ancestor carrying `key={expr}` where the expression is not constant (route params, ids),
  with the expression quoted;
- **conditional mount** — `{cond && &lt;Ancestor/&gt;}` / ternaries whose branches differ in type at that index;
- and explicitly the NEGATIVE — sibling returns rendering the same type at the same index, marked
  "reconciles in place, no remount". This is the half that is hardest to convince yourself of by reading, and
  the half a reader gets wrong.

Adjacent and worth surfacing in the same answer: `useState(propExpr)` where the initializer reads a prop and
no reset path exists — "state seeded from a prop at mount only" is the precondition that makes the remount
question matter at all.

Why an op rather than a rule of thumb: the answer is NON-LOCAL (the remount can live several components above
the one holding the state), it is easy to get confidently wrong in BOTH directions, and it decides whether
buffered drafts / `useState` mirrors of props / editors that must survive a step switch are safe. A repo with
that defect class reasons about it in prose docs precisely because nothing can answer it mechanically.

## Свидетельство

2026-08-05, external agent, amiro worktree `qa2-discount-reason`
(`src/features/sales/SalesView/AddSalePanel/`). The agent asserted the WRONG answer and it cost a [BLOCK] in
a review round: it claimed a preview-status flip recreated the editor, because `AddSaleTotalsCard` returns
from two branches each rendering `{editable && &lt;AddSaleDiscount …/&gt;}`. It does not — both roots are a plain
`div` and the editor is the same keyless child at index 0, so React reconciles in place. The REAL remount was
two levels up: `AddSaleForm` swaps `&lt;AddSaleCartFooter&gt;` ↔ `&lt;AddSalePaymentFooter&gt;` at the same sibling
position, a different component TYPE, unmounting the whole subtree. A human-equivalent reviewer had to derive
it from the JSX by hand.
