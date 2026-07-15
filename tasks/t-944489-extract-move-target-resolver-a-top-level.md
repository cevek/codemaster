---
id: t-944489
title: "extract/move target resolver: a top-level symbol name shadowed by a same-named object PROPERTY forces file:line:col — a top-level extract target shouldn't collide with a member name"
status: backlog
priority: low
tags:
  - dogfood
type: dx
complexity: S
area: ts-refactor
source: dogfood-jul
created: '2026-07-15T11:33:28.866Z'
---
**Repro (current main, hermetic).** `src/x.ts`: `export interface Rule { specificity: number }` + `export function specificity(){…}`. `extract_symbol {name:'specificity'}` → FAIL "'specificity' is ambiguous (2 distinct declarations: src/x.ts:1:25 (property), src/x.ts:2:17 (function)) — pass file:line:col or a SymbolId".

The extract/move TARGET resolver treats an interface/type PROPERTY as an equal candidate to a top-level symbol of the same name, forcing a file:line:col disambiguation for a case that is unambiguous in intent (you can't extract a property). Ask: scope the target resolver for the relocation ops to top-level declarations (properties are not relocatable extract/move targets), so a top-level symbol name isn't shadowed by a member.

Inbox source: 2026-07-10 (line 154, "Minor").
