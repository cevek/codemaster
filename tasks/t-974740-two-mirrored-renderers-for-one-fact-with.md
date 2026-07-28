---
id: t-974740
title: 'two mirrored renderers for one fact with no cross-pin: destructuresCell (ops) vs destructuresDeco (format) — converge onto a common/ contract like common/condition'
status: backlog
priority: medium
tags:
  - debt
  - output-honesty
type: imp
complexity: S
area: render
relates:
  - t-309134
  - t-480164
surface:
  - common
  - format
  - ops
audience: internal
evidence: repro
created: '2026-07-28T07:24:03.047Z'
---
`src/ops/find-usages-table.ts` (`destructuresCell`) and `src/format/render/shapes/helpers.ts`
(`destructuresDeco`) INDEPENDENTLY encode the same 4-way `CallResultShape` classification
(props / rest-marker / whole / discarded) into two different strings (`a,b` vs `⇒{a,b}`). A fifth
shape variant needs both edited, and unlike the `summarizeQueryKey`/`renderKey` pair this one has
NO cross-pin test — so the two faces of one fact can silently disagree (§3.1).

`common/condition/chain.ts` is the shape to converge on: the type + its ONE renderer live in
`common/`, which `plugins/`, `ops/` and `format/` may all import (the mirror exists only because
`format/` may not import `plugins/`, so a plugin-typed shape has no shared home). Moving
`CallResultShape` there — or, minimally, adding the missing cross-pin test — removes the drift risk.

Related: `src/README.md` should state which of the two patterns is preferred and that the mirrored
form is the legacy fallback (a `common/`-owned contract needs no pin; a mirror needs one).
