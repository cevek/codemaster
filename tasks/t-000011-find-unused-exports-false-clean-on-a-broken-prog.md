---
id: t-000011
title: find_unused_exports` false-clean on a broken program (no filter)
status: done
priority: high
type: bug
complexity: S
area: impact-usages
relates:
  - t-000005
  - t-000010
  - t-647309
surface:
  - ops
  - plugins/ts
audience: both
evidence: reported
created: '2026-07-08T00:00:10.000Z'
---
**`find_unused_exports` false-clean on a broken program (no filter)** — when the LS program is
`undefined` (`src/plugins/ts/unused-exports.ts:87`) and NO pathInclude/pathExclude is set, the op
returns `unused(0)` / `scanned 0 files` with NO warning — the vacuous-filter guard gates on
`filterSet`, so a broken/empty program reads as "nothing dead" (a §3.4 false-clean in the
no-filter path the filter guard doesn't cover). Rare (needs a program-load failure), surfaced in
T2 review. Fix: warn on `scannedFiles===0` regardless of filter, or on `program===undefined`.
`bug`·`low`·`cx:S`


## CONTRACT CHANGE — the data key was RENAMED, not added

`find_unused_exports` no longer emits `filterMatchedNoFiles`. The empty-walk warning is now
**`notAVerdict`** — one key for both causes that empty a walk (a scope filter matching nothing, or a
program covering no source file), because a consumer forced to probe two keys to learn whether a
verdict exists is the defect this closes; the cause and its own lever live in the string.

A `format:'json'` / sql consumer reading the old key gets `undefined` and, reading it as "no
warning", would read a vacuous scan as clean — the exact failure this task is about, one level up.
Both in-repo consumers (the op's own `table.notes` projection and its test) are converted; external
ones are not ours to convert, which is why the rename is recorded here rather than only in the git
log.

The `!! NOT A VERDICT` marker string itself now has one home — `ops/scan-coverage.ts`
(`NOT_A_VERDICT_MARKER`) — shared with the type-anchored scans that already printed it, so the two
readings cannot drift apart.

The other half of the fix has no key at all: when the LS produces no Program, the op returns
`ToolFailure{tool:'ts-ls'}` (`ok:false`, no `data`) instead of an empty list.
