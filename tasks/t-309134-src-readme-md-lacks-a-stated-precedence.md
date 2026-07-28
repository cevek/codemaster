---
id: t-309134
title: src/README.md lacks a stated precedence for the two shared-render patterns (common/-owned contract vs mirrored renderer + cross-pin)
status: backlog
priority: low
tags:
  - docs
type: doc
complexity: S
area: docs
relates:
  - t-480164
  - t-974740
surface:
  - docs
audience: internal
evidence: repro
created: '2026-07-28T07:25:10.775Z'
---
The tree now holds two patterns for one problem — a display contract a plugin produces and `format/`
renders — with no stated precedence, so the next author picks by coin flip:

- **`common/`-owned contract** (`common/condition/chain.ts`, `common/trace/`): type + renderer live in
  `common/`, which `plugins/`, `ops/` and `format/` may all import. No cross-pin test needed, because
  there is one renderer.
- **mirrored renderer + cross-pin** (`format/render/shapes/helpers.ts` `summarizeQueryKey` ↔
  `ops/react-query-invalidations-for.ts` `renderKey`): two renderers kept honest by a guard test. The
  reason it exists is that `format/` may NOT import `plugins/`, so a shape whose home type must stay a
  plugin type has no shared home.

`src/README.md` already states cross-cutting patterns ("Render dispatch is tagged", "Truncation goes
through one chokepoint"). Add a fourth in the same voice: prefer the `common/`-owned contract; the
mirrored form is the fallback for a plugin-typed shape and MUST carry a cross-pin test. See t-974740
for the one mirrored pair currently missing that pin.
