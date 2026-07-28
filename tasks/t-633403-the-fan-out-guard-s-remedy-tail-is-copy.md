---
id: t-633403
title: The fan-out guard's remedy tail is copy-pasted across ~13 op notes, so a wording fix means 13 manual edits
status: backlog
priority: medium
tags:
  - agent-surface
  - debt
type: imp
complexity: S
area: render
source: dogfood-jul
relates:
  - t-034392
  - t-286255
  - t-702879
  - t-847874
surface:
  - ops
  - ops/guard
audience: internal
evidence: measured
created: '2026-07-28T13:00:00.094Z'
---
Every op carrying the semantic fan-out guard repeats a byte-identical tail in its static `notes[]`:

> …plus the one remedy for that cause. `force:true` does NOT override it (forcing killed the daemon
> in production). No refusal in an escalated / configured process-mode child.

Sites: `impact.ts`, `member-usages.ts`, `importers-of.ts`, `affected.ts`, `find-unused-exports.ts`,
`find-unused-props.ts`, `impact-type-error.ts`, `trace-invalidation.ts`, `trace-field-to-render.ts`,
`trace-prop-through-tree.ts`, `trace-type-widening.ts`, `find-unused-scss-classes.ts`,
`find-definition.ts`, `find-usages-notes.ts`.

The HEAD of each note is legitimately per-op (why THAT op fans out). Only the tail is shared, and it
has already been edited across all copies by hand twice (t-693742, t-754922) — the cost is realised,
not hypothetical.

The home is obvious and carries no bad coupling: a constant beside the guard in `src/ops/guard/`,
which every one of these files already imports `semanticFanoutRefusal` from, with the per-op cause as
the parameter.

Caveat for whoever takes it: `find-usages-notes.ts` is not a shared module — it exists to keep
`find-usages.ts` under the line cap — so there is no in-repo precedent for extracting note text, and
the extraction should not be mistaken for one.

Related: this is the same defect class as t-034392 (one claim, one home). The refusal MESSAGE was
consolidated into `ops/guard/navigate.ts`; the refusal NOTE was not.
