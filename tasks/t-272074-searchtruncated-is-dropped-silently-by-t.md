---
id: t-272074
title: searchTruncated is dropped silently by the name-addressed reads that are not find_definition/find_usages
status: backlog
priority: medium
tags:
  - honesty
  - ops
  - ts
created: '2026-07-28T11:00:44.269Z'
---
A bare-`{name}` read whose navto candidate page the LS sliced (`searchTruncated`, ARCHITECTURE.md §5-L2) discloses `complete:false` + a `!! LOWER BOUND` note in `find_definition` and `find_usages` only. The other name-addressed reads answer off the same sliced page with NO incompleteness signal — a resolution that may have picked the wrong same-named declaration reads as certain (§3.4/§3.6).

Structural cause: the bit is surfaced by exactly two plugin-API methods — `findDefinition` and `findUsages` (`src/plugins/ts/api.ts`). `expandType` / `constructionSites` / `discriminationSites` / `referenceSpans` (`src/plugins/ts/plugin.ts`) never propagate it, so their ops cannot consume it even if they wanted to.

Ops that drop it today: `src/ops/source.ts`, `src/ops/impact.ts`, `src/ops/impact-type-error.ts`, `src/ops/trace-field-to-render.ts`.

Fix shape: propagate `searchTruncated` through the remaining resolve-returning API methods, then consume it via the existing `searchCapFloor` (`src/ops/no-symbol-hint.ts`) at each op — the vocabulary and the note already exist, so this is wiring, not new design. A seam that makes the coverage automatic rather than per-op (cf. t-820448 for the fan-out guard) is the better end state if the wiring turns out to be mechanical at every call site.

Scope note: mutations are already safe — `resolveForWrite` refuses (§7). This is the read side only.
