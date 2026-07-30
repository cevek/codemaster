---
id: t-042123
title: 'trace_prop_through_tree: headline counters have no legend and the hop list is flat — the reader guesses what was counted and rebuilds the tree by hand'
status: backlog
priority: medium
type: dx
complexity: S
area: trace
source: dogfood-jul
relates:
  - t-919920
surface:
  - src/ops/trace-prop-through-tree.ts
audience: external
evidence: repro
created: '2026-07-30T19:58:25.527Z'
---
Output on a 6k-file monorepo (`ModalBase` / `onClose`): `found=1 propDeclared=true reaches=1 dynamicHops=1`,
then three hops.

**Counters are not self-describing.** A first-time consumer cannot tell `found=1` of WHAT (components
matching the name? roots?) or `reaches=1` of WHAT (leaf sinks? components that consume rather than forward?).
Every other op's counters carry their own unit (`total`/`shown`/`blockers`). One-word suffixes close it:
`found=1 root component · reaches=1 terminal consumer`. Same class as the bare `scanned:` counter already
fixed elsewhere (t-919920) — a number without its unit is read as evidence of work done.

**The hop list is flat.** The tree shape (two components are BOTH children of the root, a third sits under
one of them) must be reconstructed by re-reading file paths in the arrows. An indent, or parent→child
numbering, makes it readable at a glance — and this op's entire subject is a TREE.
