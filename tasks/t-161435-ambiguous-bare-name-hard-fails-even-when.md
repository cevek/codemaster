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
relates:
  - t-000095
  - t-791164
  - t-821130
  - t-944489
surface:
  - ops
  - plugins/ts
  - test
audience: both
evidence: repro
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

## Implementation recipe (from the worker who owns the resolve seam, t-128204)

Assessed as S/M, deliberately NOT folded into t-128204's diff. Reason it is not a few lines: the filter
is a DISPLAY filter today and making it a co-resolver needs three things beyond the filtering itself.

1. **Thread the call's filter into `resolveTarget`.** `UsageOptions.pathInclude` currently reaches only
   `usages.ts`; it does not flow to target resolution. This adds a parameter to the shared resolver used
   by EVERY symbol-addressed op — not a local change.
2. **A disclosure channel for "narrowed by your filter"**, modelled on the `searchTruncated` →
   `searchCapFloor` pair built in t-128204. Without it this is a silent change of target — precisely the
   class t-128204 existed to close.
3. **Decide the semantic boundary.** Narrow on PATH filters only, never on `kind` / `exportedOnly` /
   `role` (otherwise `role:'call'` starts selecting the declaration). Decide separately what it means for
   `find_definition` / `expand_type`, and for WRITE paths — `resolveForWrite` refuses today, and allowing
   a filter-narrowed target on a mutation needs its own gate.

Concrete recipe, so the next wave does not re-derive it:
- Narrow ONLY when `distinct.length > 1` — i.e. exactly on today's hard-FAIL. A successful resolve stays
  byte-identical.
- Filter the already-COLLAPSED candidates (`distinctDeclarations`), not the raw navto hits.
- Still fail on 0 or ≥2 survivors.
- Oracle arm: two same-named symbols + `pathInclude` selecting one → resolves, and a leading note names
  the narrowing; the same call without the filter → the prior ambiguity FAIL.

## The `mergeDeclarations` workaround is now worse than "semantic widening"

After t-128204 it also marks the answer `complete:false` whenever the candidate set was capped. So a
recipe built on `mergeDeclarations` carries a permanent LOWER BOUND — one more reason to make
filter-narrowing work properly rather than routing around it.

## Field instance: a duplicate-by-design sub-package (dogfood-jul, /Users/cody/Dev/task-manager)

An isolated web SPA sub-package (`web/`, own tsconfig/package.json) deliberately re-declares the servers wire
types so the browser never imports core. So `CommitReport` exists twice BY DESIGN — `src/model/commit.ts:21`
and `web/src/api/types.ts:164` — and every bare-name symbol op hard-fails:

    expand_type {name:"CommitReport"} → FAIL … ambiguous — shown 2 of 2 distinct declaration sites
    find_usages {name:"CommitReport"} → same

The caller always wanted the `src/` one (the `web/` twin is a mirror they are not editing) and spent a failed
call per symbol to learn the SymbolId. The disambiguating fact was available up front and expressible —
`find_usages` already takes `filter.pathInclude` — it just applies to RESULTS, after resolution, so it cannot
pre-empt the ambiguity.

### Two requirements this instance adds

1. Zero survivors must NOT read as "not found": say the filter excluded all N candidates. The two are very
   different and an agent must not read one as the other.
2. Todays placement makes an easy mistake silent-ish: `find_usages {name, filter:{pathInclude:["src/**"]}}`
   on an UNAMBIGUOUS name filters result rows, which reads as if it scoped the target. Making the same key do
   target-scoping when it can, and SAYING which it did on the envelope, removes that too.

`mergeDeclarations:true` already covers the union case; this is the missing opposite — pick ONE without a
round-trip.
