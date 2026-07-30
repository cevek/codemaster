---
id: t-467009
title: trace_type_widening scans ONE program and renders a verdict over it — the third instance of the single-program-scan false zero, to be closed with the shared scope/floor helper
status: backlog
priority: high
parent: t-647309
type: bug
complexity: M
area: multi-program
source: dogfood-jul
relates:
  - t-162650
  - t-259465
  - t-820448
  - t-885983
surface:
  - ops/trace-type-widening.ts
  - plugins/ts/type-widening.ts
audience: both
evidence: measured
created: '2026-07-30T12:10:44.400Z'
---
## The class, and the full consumer census

`host.typeAuthorityFor(abs).getProgram()` returns exactly ONE program, and an op that then iterates its
`getSourceFiles()` is scanning one program while rendering a verdict that reads as repo-wide. Census of the
five consumers (`find_usages {name:'typeAuthorityFor', mergeDeclarations:true}`):

| consumer | op | iterates files? |
|---|---|---|
| `findConstructionSites` (`plugins/ts/construction-sites.ts:94`) | construction_sites | YES — t-162650 |
| `findDiscriminationSites` (`plugins/ts/discrimination-sites.ts:95`) | discrimination_sites | YES — folded into t-162650's track |
| **`collectWideningSinks` (`plugins/ts/type-widening.ts:60`)** | **trace_type_widening** | **YES — this task** |
| `expandTypeAt` (`plugins/ts/type-expand.ts:25`) | expand_type | no — reads a type at a position |
| `firstParamTypeMembers` (`plugins/ts/first-param-members.ts:53`) | find_unused_props | no — reads first-param members |

So the class has exactly three members and this is the third. It is filed separately, not folded in, so the
construction_sites track terminates — the shared scope/floor helper it builds is the instrument this task
then uses.

## Why it is the same defect, not merely the same call

A widening trace answers "where does this value's type widen along assignments / calls / returns". A sink in
a sibling program (a `test/**` file under `tsconfig.test.json`, another package's app program) is invisible,
and the answer does not say a program went unscanned — so an agent reads "the type does not widen anywhere"
where the truth is "we looked in one program". That is the §3.6 laundering of a couldn't into a proven
absence, and the trace family's per-hop confidence vocabulary makes the silence worse: every hop is marked
honestly while the SET of hops is silently partial.

## Scope

Take the helper `t-162650` produces — positive `programsScanned: [labels]`, `complete:false` + the shared
`!! LOWER BOUND` note, and the rule that an empty SCAN is never rendered as a semantic verdict — and apply
it here. Fan across `programsContaining(decl)` if the measurement justifies it: on this repo the second
program costs +654 ms / +85 MB RSS, and the scan surface with file-level dedup is the UNION (711), not the
sum (432+711).

Two constraints inherited from that track, both non-negotiable:

1. **Resolve the target type IN each program.** Assignability / type identity is not valid across programs.
2. **A budget exhausted before reaching program P is NOT the undiscovered-config claim.** Different cause,
   different remedy (`limit` / `pathInclude` is a lever that works; "index the config" is not), so it needs
   its own wording — gated by t-885983.

Also add the `semanticFanoutRefusal` call if the fan is added: adding a cross-program fan to an op that
lacked one increases exactly the exposure the guard exists for (t-820448's coverage class; note the guard
fires only `in-process`, so the protection is partial by design).
