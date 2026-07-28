---
id: t-272074
title: searchTruncated is dropped silently by the name-addressed reads that are not find_definition/find_usages
status: done
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

## Closed by construction, not by enumeration (t-876408, merged as a450f5c)

The disclosure is stamped AT THE RESOLVE chokepoint (`plugins/ts/plugin.ts` `resolve` closure + the merge
branch), which sits ABOVE every plugin API method. So whether an op threads `searchTruncated` by hand is
no longer relevant: `expandType` / `constructionSites` / `discriminationSites` / `referenceSpans` still do
not thread it, and their consumers disclose anyway.

This task's framing — "the op does not forward the flag" — stopped describing a defect: there is nothing
left to forward and no one left to forget.

Measured set, derived from the producer and verified by running it (not read off the source): ALL ELEVEN
read ops that resolve a ts target inherit the disclosure — `find_usages`, `find_definition`, `expand_type`,
`impact`, `member_usages`, `source`, `construction_sites`, `discrimination_sites`, `trace_type_widening`,
`impact_type_error`, plus `trace_field_to_render`, which carries its own argument shape (`field`), forwards
nothing, and inherits regardless. That last one is the proof the CLASS closed rather than a list shrinking.

Worth recording: this task's list of mute ops and t-876408's list were BOTH incomplete and did not even
agree with each other — each was read off the source by a different agent. The measured set was larger than
either. Reading enumerates what you thought to look for; running enumerates what is.

Mutating ops are excluded by design — they go through `resolveForWrite` and REFUSE. A write cannot ride an
ambiguity gate that did not fire (§7).
