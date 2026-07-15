---
id: t-242381
title: Co-moving mutually-referencing symbols into one NEW dest emits a self-import from the OLD module → "Import declaration conflicts with local declaration"; gate refuses, the co-move can't complete
status: done
priority: high
tags:
  - dogfood
type: bug
complexity: M
area: transaction
source: dogfood-jul
created: '2026-07-15T11:30:57.706Z'
---
**Repro (current main, hermetic).** `src/types.ts` has interrelated interfaces: `CssProperty`, `CssStyle{props:CssProperty[]}`, `CssRule{style:CssStyle}`, `MatchedStyles{rules:CssRule[]}`. A `transaction` `extract_symbol CssProperty → src/css-types.ts` (NEW file) then `move_symbol CssStyle/CssRule/MatchedStyles` into that same file produces:

    src/css-types.ts:
      import { CssProperty, CssRule, CssStyle } from "./css-types";   ← self-import
      export interface CssProperty { … }
      export interface CssStyle { … }  …

→ 3× `Import declaration conflicts with local declaration of 'CssProperty'/'CssRule'/'CssStyle'`. The §2.8 gate correctly REFUSES (clean=false, nothing written) — honest and safe — but the co-move can't complete.

Root: the import planner resolves a co-moved symbol's reference target against the PRE-transaction layout, so it emits an import for a symbol that has ALREADY landed in the dest. It must recognize that a reference whose target is another co-moved symbol now co-resident in dest needs NO import (and never a self-import from the old module).

This is the class the user surfaced ("взаимозависимые сущности, по одному не вытащить"): the capability the transaction promises for interdependent clusters is real but produces broken edits here. Likely shares a root cause with the import-capture-resolved-against-pre-transaction-layout gap.

Inbox source: 2026-07-10 (line 167). Related: t-000113 (in-transaction reverse import-capture not overlay-aware), t-000107.
