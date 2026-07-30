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

## CORRECTION — the mechanism is REFERENCES, not files (measured on current main)

The census table above places `collectWideningSinks` in the "iterates files? YES" column. That is WRONG, and
the error is inherited from filling the column by analogy with the two neighbours rather than reading this
one. `collectWideningSinks` does not call `getSourceFiles()` at all:

    plugins/ts/type-widening.ts:80 — authority.service.getReferencesAtPosition(abs, offset)   // cap REF_SCAN_CAP = 50

So the enumeration is over REFERENCES of the value, bounded by a per-node reference cap — while
`construction_sites` / `discrimination_sites` enumerate files × nodes. The CLASS of defect is identical (one
program consulted, verdict reads as repo-wide), the mechanism is not.

Consequences, both load-bearing for whoever works this:

- **`runFanoutScan` does NOT fit.** Its enumeration is `getSourceFiles()` × `forEachChild` per node, which for
  a widening walk is O(programs × files × nodes) on EACH of ≤200 hops, against today's O(refs ≤ 50). That is a
  never-hang regression (§1), not a style preference. `selectScanFanout` DOES fit and is reused as-is
  (program set, authority-first, no-config-fallback demotion — same soundness argument).
- **`ScanCoverage` / `ops/scan-coverage.ts` does NOT fit either, for a reason orthogonal to the structure's
  fan-shape:** it is FILE-denominated, and `scanCompleteness:45` discriminates on `coverage.walkedFiles === 0`.
  A value with no forward references has a file denominator of 0 while the fan consulted every program and the
  absence IS established — so the module would print `!! NOT A VERDICT` over a complete answer: §3.6's
  same-lie-inverted, inside the module built to prevent it. Faking `walkedFiles` as "programs" would put the
  lie in the structure. Its `budgetNote` / `emptyScanRemedy` are also inapplicable — they name `limit` /
  `pathInclude`, arguments this op does not have (an inert lever, t-259465).

The op therefore gets a REFERENCE-denominated coverage of its own, in its own files, rendering the proven
t-919920 shape with the unit stated in the line:

    programsScanned: ["tsconfig.json: 12 forward reference(s), 12/12 checked", "tsconfig.test.json: 3, 3/3"]

sharing the PROSE (the `!! NOT A VERDICT` marker and the empty-scan doctrine, exported from
`ops/scan-coverage.ts`) but not the structure. `lowerBoundNote` (undiscovered configs) IS shared — that fact
is denominated in configs, not in files.

Repro of the underlying defect on current main (two sibling programs): `trace_type_widening
{name:'color',file:'src/a.ts'}` → `widenings=0 found=0 hops(0)`, a bare zero with no word about scope, while
`find_usages` on the same symbol finds `test/uses.ts:3:7 · prog tsconfig.test.json` — which is exactly the
`'red'` → `string` sink.
