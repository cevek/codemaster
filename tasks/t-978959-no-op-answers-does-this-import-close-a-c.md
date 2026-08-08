---
id: t-978959
title: No op answers "does this import close a cycle" / "list the import cycles" — importers_of is one level deep, so a cycle is found by a human reviewer on a purely structural, statically decidable question
status: backlog
priority: high
tags:
  - agent-surface
  - dogfood
type: feat
complexity: M
area: impact-usages
source: dogfood-inbox-aug
relates:
  - t-500947
audience: external
evidence: reported
created: '2026-08-08T12:04:21.111Z'
---
## What is missing

`importers_of` answers one level ("who imports X"). Nothing answers the transitive question — "will this
edge close back on X" — so establishing it means chaining `importers_of` by hand over a transitive closure
and diffing sets, which is exactly the work codemaster is taken on to remove.

Wanted, in order of value:

1. **Predictively** — the `impact_type_error` shape: "I am adding `import B` to `A`; does a cycle appear,
   and which one". This is the highest-value form because the question arises AT the edit, not at review.
2. **As an inventory** — cycles in the project, or cycles touching module X, with the cycle path
   (`A → B → A`) and, crucially, whether the cyclic references sit inside function BODIES (harmless today)
   or at MODULE level (a TDZ hazard right now). That second half is what separates "works by accident" from
   "works by construction".
3. Optionally, a layer-direction signal by path (`handlers/` ↔ `seed/`): a back-edge against an unwritten
   layering rule is not a cycle but is a defect of the same family.

## Why silence here is expensive

ESM swallows a cycle whose references all live in function bodies: typecheck is quiet, tests are green, and
it detonates later, for a different person, when someone adds a module-level call or gates the operation the
cycle closed through.

## Свидетельство

2026-08-02, `amiro/t-team-scheduling-gates`. An import from `./authz-guard` was added to
`src/local-api/handlers/authz.ts` while `authz-guard.ts` already imported `authzHandlers` from `./authz` — a
cycle. It survived only because `myAuthzPermissions` was itself ungated, and the same diff was in the middle
of gating the neighbouring operations. Found by a HUMAN reviewer, not by tooling. The same diff carried a
layer back-edge of type (3): a handler imported defaults from `seed/`, while `seed/index.ts` imports the
handlers.

Adjacent naming friction from the same report: `find_phantom_deps` sounds like the op that might catch this
and is about something else — the reporter did not even try it because the name led away.
