---
id: t-876408
title: 'Sibling read ops drop the name-search truncation the resolver computes: expand_type / impact / member_usages / source answer without the lower-bound verdict find_usages and find_definition carry'
status: done
priority: high
tags:
  - agent-surface
  - dogfood
type: bug
complexity: M
area: impact-usages
source: dogfood-jul
created: '2026-07-28T08:23:36.729Z'
---
`resolveTarget` reports when a bare-`{name}` resolution was built on a candidate page the LS had
already sliced (`ResolvedTarget.searchTruncated`, `plugins/ts/resolve-target.ts`) — a same-named
declaration may sit behind the cut, so the resolved symbol is "one of the ones we could see".

Three consumer classes exist today:

- **Disclosing** — `find_usages` (both the single-target and `symbols:[…]` sections) and
  `find_definition` carry `complete:false` + `searchTruncated:true` + a `!! LOWER BOUND` note via
  `ops/no-symbol-hint.ts` `searchCapFloor`.
- **Refusing** — the mutating paths (`rename_symbol` / `change_signature` / `move_symbol` /
  `extract_symbol`) refuse outright through `resolveForWrite`: a write may not ride an ambiguity
  gate that did not actually run (§7).
- **Silent** — everything else that resolves through `plugins/ts/plugin.ts`'s `resolve`:
  `expand_type`, `source`, `construction_sites`, `discrimination_sites`, `reference_spans`,
  `impact`, `member_usages`. They drop the flag on the floor.

Repro (a fixture with 199 `export const span` beside 5 `export interface Span`, bare `{name:'Span'}`):
`find_usages` answers `complete=false, searchTruncated=true`, while `impact` answers `complete=true,
dependents=0` and `member_usages` answers `complete=true` for the same target in the same session.
Both `complete` fields mean something narrower (walk / program coverage for the RESOLVED symbol), so
neither is strictly false — but an agent reading two contradictory verdicts for one target cannot
tell that, and `member_usages`' own note already promises that an undiscovered sibling tsconfig
demotes `complete`; the page cap is the same class of incompleteness.

Fix shape: thread `searchTruncated` out of the remaining `plugin.ts` read methods (the shape is
already there for `findDefinition` / `findUsages`) and reuse `searchCapFloor` in each op. The lower
ones (`expand_type` / `source`) at least print `at=<file:line:col>`, so the agent can see WHICH
declaration answered; `impact` / `member_usages` do not.

## Root fix: disclosure belongs on the ENVELOPE, not hand-plumbed per op

From worker cc8ddaaa, which shipped the per-op version and reports the cost: threading ONE fact
(the LS search page was truncated, so a completeness claim is not safe) took edits in SEVEN places and
STILL left four ops mute — the exact asymmetry this task describes. Hand-plumbing a cross-cutting honesty
signal does not converge: every new consumer must remember to consume it, and forgetting is silent.

So the ask sharpens from "make the neighbours agree" to "stop making agreement a per-op obligation":
resolve-time provenance (was the candidate set complete? was the page capped? was the target narrowed?)
should ride the `Result` envelope from the point of resolution, so every op that answers about that target
inherits the same disclosure without opting in.

## Design lesson worth keeping — a boolean was too coarse, and the gap shipped two false refusals

`searchTruncated` was SET on an event ("the page overflowed") and CONSUMED as an assertion ("same-named
declarations may be missing"). Those are not the same claim, and the gap between them produced two
regressions in this track's own review rounds: ~200 unrelated prefix matches blocked renaming a uniquely
named symbol, and an exact handle inherited truncation and failed with a message about a bare name it
never had.

Generalizable: an honesty flag must encode WHAT IS UNSAFE TO CLAIM, not what happened upstream. If the
producer's event and the consumer's question differ, one bit cannot bridge them — the fix was to set the
flag only when the retained page's tail is still in the exact-match bucket, i.e. to express the assertion
directly rather than its cause.
