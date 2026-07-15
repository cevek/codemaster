---
id: t-271823
title: Generalize name+file member/re-export resolution into the shared resolveTarget (find_definition / expand_type still dead-end on a member)
status: backlog
priority: low
tags:
  - dogfood
created: '2026-07-15T13:20:37.906Z'
---
t-755152 added a member / re-export fallback to `find_usages {name,file}` at the OP level (`ops/find-usages-member-fallback.ts` + `ts.membersNamedInFile`): when no TOP-LEVEL declaration of `name` lives in `file`, it resolves a class/type MEMBER, enum member, or re-exported binding and re-issues by position.

That fallback is find_usages-scoped by design (boundary: the shared `plugins/ts/resolve-target.ts` `resolveNameInFile` is track A / ts-target territory). So the SAME name+file addressing still dead-ends with "no top-level declaration named X" on the OTHER symbol-addressed ops — `find_definition`, `expand_type`, `construction_sites`, `impact`, etc. — which funnel through `resolveNameInFile`.

**Ask.** Lift the member/re-export resolution into `resolveNameInFile` (or a shared step it calls) so every symbol-addressed op benefits uniformly, then drop the op-level fallback in favor of the shared one. Keep the honest disclosure (a member is not the top-level the agent addressed) and the >1 pick-list. The engine already exists (`ts.membersNamedInFile` / `nonTopLevelDeclarationsNamed`) — this is a relocation + wiring across ops, not new capability.

Reference: t-755152 (find_usages member fallback, DONE).
