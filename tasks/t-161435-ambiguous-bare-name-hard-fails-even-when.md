---
id: t-161435
title: Ambiguous bare `name` hard-FAILs even when the call's own filter.pathInclude selects exactly ONE declaration — forces file:line:col into recipes, which then rot when the line moves
status: backlog
priority: high
tags:
  - agent-surface
  - dogfood
type: feat
complexity: M
area: impact-usages
source: dogfood-jul
created: '2026-07-28T08:23:56.250Z'
---
Filed to the inbox by worker fa42a33c mid-track (2026-07-28 07:01), converted here.

Repro on codemaster itself (629 files, warm):
`find_usages {name:'defineOp', role:'call', filter:{pathInclude:['src/ops/**']}}` →
"'defineOp' is ambiguous (2 distinct declarations: src/ops/registry.ts:161:17 (function),
test/e2e/watchdog-harness.ts:81:11 (const))".

The refusal is honest, but the call ALREADY carried the disambiguation: only one of the two declarations
lives under the given `pathInclude`. Target resolution runs BEFORE the display filter, so the filter
cannot help, and the agent is left with two bad options — hard-code `file:line:col` (position-brittle),
or `mergeDeclarations:true` (unions two unrelated symbols: a semantic widening, not what was asked).

Why this is more than ergonomics: it rots the anti-join recipe that t-933867 is documenting as a pasteable
audit. The family producer must hard-code `registry.ts:161:17`, so the published recipe **silently breaks
the moment that line moves** — a documented artifact with built-in decay.

Ask: when a bare `name` is ambiguous AND exactly ONE candidate declaration survives the call's own
`filter.pathInclude`/`pathExclude`, resolve to it and DISCLOSE the narrowing (a leading note, the way the
`{name,file}` member fallback discloses its resolution). Keep failing when 0 or ≥2 survive — the ambiguity
is real there. Same shape helps `find_definition` / `source`.

Lands in the resolve path reworked by t-128204 (`resolve-target.ts` + `ResolveNarrowing`), so it is a
natural extension of that seam rather than a new one.
