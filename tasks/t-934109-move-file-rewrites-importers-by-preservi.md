---
id: t-934109
title: move_file rewrites importers by preserving their prior specifier STYLE with no depth ceiling, so an applied "typecheck=clean" move can grow a relative path past the repo's own lint rule
status: backlog
priority: high
parent: t-915659
tags:
  - dogfood
  - ts-refactor
type: bug
complexity: M
area: ts-refactor
source: dogfood-inbox-aug
relates:
  - t-358801
surface:
  - ops
  - plugins/ts
audience: external
evidence: reported
created: '2026-08-08T12:01:34.194Z'
---
A rewritten import specifier inherits the importer's prior form — alias importers get the alias, relative importers stay relative — and the relative branch has no ceiling. A move that increases the distance between importer and target therefore GROWS the relative path, and a repo that restricts `../../../` (the common `no-restricted-imports` "use `@/` past two levels" rule) goes red on its own verify command immediately after an `applied, typecheck=clean` mutation. The caller then hand-edits the very import the op exists to own.

The rewrite is already capable of the alias form — it emits it for importers that used one — so the fix is a choice of specifier, not new machinery:

- cap relative depth: past N `../` segments emit the `tsconfig` paths alias regardless of prior style (read the repo's own eslint `no-restricted-imports` patterns where possible, else expose `relativeDepthLimit`);
- weaker, config-free floor: never GROW a relative path across a move — prefer the alias whenever source and dest sit in different directories and the importer is neither sibling nor child of either.

Second half, shared with the move family: `typecheck` is the ONLY post-condition reported, and for a repo whose canonical verify is lint+typecheck+test it reads as "safe to commit". The applied envelope should say what it checked — "typecheck only; lint/test not run" — so the verdict is not read wider than it was established (§3.6).

## Свидетельство

2026-08-05, external field report, `amiro` worktree `qa2-settlement-panel`, cm=0.1.0.

`move_file {source:'src/features/sales/SalesView/sales-money.ts', dest:'src/features/sales/sales-money.ts', apply:true}` → `mode=applied typecheck=clean, 11 touched`, 9 importers rewritten. Then `pnpm run fix-and-check` failed at once:

```
src/features/sales/SalesView/SaleEventDetailPanel/SaleEventDetailBody/SaleEventDetailBody.tsx:7
import {parseEuro} from '../../../sales-money.ts';
→ eslint(no-restricted-imports): "Imports going up more than two directories should use the `@/` alias (mapped to `src/`)."
```

In the SAME run, `sale-to-billing-row.ts` and `use-payment-section-data.ts` were rewritten to `@/features/sales/sales-money.ts` — they had alias imports before. So the emitted form is the importer's prior style, and only the relative branch has no bound.

Sibling post-condition defect on the same family: [[t-358801]] (a move whose only way to compile is a new back-import, reported as clean).
