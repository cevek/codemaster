---
id: t-915659
title: "EPIC: a mutating op's reported post-condition does not establish what the caller reads it as establishing"
status: backlog
priority: high
tags:
  - dogfood
  - epic
  - honesty
  - refactor-ops
type: imp
complexity: M
area: correctness
source: dogfood-inbox-aug
surface:
  - ops
  - plugins/ts
audience: both
evidence: repro
created: '2026-08-08T12:09:07.051Z'
---
Every mutating op reports `typecheck` as its verdict, and a caller reads that verdict as "the edit did what I asked". Those are different claims, and the gap between them is where this family lives: the typecheck can be clean BECAUSE the op compensated for its own incomplete work.

`typecheck=clean` establishes exactly one thing — the tree still compiles after the edit. It does NOT establish that the relocation completed, that the resulting import direction is legal, that the repo's own lint gate still passes, or that the artifacts the edit orphaned were cleaned up. An op that reports only the typecheck, and reports it as the verdict, presents the weaker claim in the position where the caller expects the stronger one.

This is the §3.6 honesty rule applied to the WRITE path: report capability, not just data. A read op that cannot establish something says so; a mutating op currently stays silent about every post-condition it did not check, while printing the one it did as if it were the whole answer. The damage is worse than on the read path because the edit is already applied in someone's repository by the time the verdict is read.

## What the fix has to carry

A mutating op states which post-conditions it verified and which it did not run — the same closed-vocabulary shape the read ops use for their coverage. `typecheck: clean` alone is a partial verdict rendered as a total one; naming the un-run checks (lint, test, layering direction, orphaned artifacts) is what makes it honest, independent of whether we ever run them.

Note the inversion trap this family sits on top of: a check that COMPLETED and found nothing has established absence and must not be hedged. The defect is the un-run check reported as a passed one, never the passed check itself.

## Instances

- t-358801 — `move_symbol` leaves a signature-referenced type behind and writes a back-import from dest into the source folder; the layering is inverted and the verdict is `clean` precisely because the op added that import. Live repro on current main, in this repo, one command.
- t-934109 — `move_file` grows relative specifiers past the repo's own `no-restricted-imports` depth limit; `applied, typecheck=clean` is immediately followed by a red lint gate. The tool already emits the alias form for importers that had it, so this is specifier-form choice, not mechanics.
- t-701638 — prose, JSDoc and `.md` naming the old path are never rewritten and never reported; the co-located sibling test does not move. The op knows both paths at that moment and says nothing.
- t-619235 — `move_file` leaves the emptied source directory behind.

Each instance is independently actionable; the epic exists because the verdict shape is one decision, and fixing it per-op would leave each new mutating op re-deciding it.
