---
id: t-358801
title: move_symbol reports typecheck=clean over a move that only compiles because the DEST now imports back into the source's folder — the inverted edge is neither prevented nor disclosed
status: backlog
priority: urgent
parent: t-915659
tags:
  - dogfood
  - honesty
  - ts-refactor
type: bug
complexity: M
area: ts-refactor
source: dogfood-inbox-aug
surface:
  - ops
  - plugins/ts
audience: external
evidence: repro
created: '2026-08-08T12:01:12.656Z'
---
Moving a symbol whose SIGNATURE names a type declared in the same source file leaves that type behind and writes a NEW import into the destination, pointing back at the source module. The envelope reports `typecheck=clean` and nothing else, so the only post-condition a caller sees is satisfied while the move has, by construction, not finished: a destination that can only compile by importing back into the source's own folder has moved the code and left the ownership where it was — precisely the coupling such a move is performed to remove.

`typecheck=clean` is a true statement about the compiler and a misleading statement about the move. The verdict-bearing envelope of a mutating op is where a caller decides "done"; an edit that creates a new back-edge into the source's directory is cheaply detectable (the dest gained an import whose specifier resolves under the source file's directory) and belongs on that envelope — "moved, but the destination now imports N symbol(s) back from the source's package" — even if the op still applies.

Two levers, in order of value:
1. **Disclose the new back-edge** on the envelope of every symbol relocation (`move_symbol`, `extract_symbol`), beside `typecheck`. This is the honesty half: today the answer establishes nothing about the layering and reads as though it had.
2. **Carry the signature's own types** when they are declared in the same file and have no other referent there after the move (offer it, or do it under a flag) — in the field case a strictly-better move was available and not taken.

## Свидетельство (repro live on current `main`, 2026-08-08)

`node src/bin.ts op move_symbol '{"name":"applyAliases","dest":"src/ops/intake/normalize.ts"}'` in this repo:

- `typecheck=clean`, touched 2, one note about the §2.8 gate — and nothing else;
- `export interface AliasResult` (the moved function's declared return type, declared immediately above it and referenced by nothing else in the source) stays in `src/ops/intake/aliases.ts`;
- `src/ops/intake/normalize.ts` gains `import type { AliasResult } from './aliases.ts';`

Field report, 2026-08-05, external, `amiro` worktree `forms-w3-ceiling`, cm=0.1.0: `move_symbol {name:'useEmployeeDirectoryEntry', dest:'src/api/hooks/useEmployeeNameMap.ts', apply:true}` moved the hook out of `src/features/team/TeamMemberDetailPanel/use-team-member-data.ts`, left `EmployeeDirectoryEntry` behind, and wrote `import type {EmployeeDirectoryEntry} from '@/features/team/TeamMemberDetailPanel/use-team-member-data'` into a shared `src/api/hooks/` module — a shared layer now importing a type out of a feature panel folder. Result: `applied:true, typecheck:'clean', touched:3`. Found by reading the file afterwards. Reporter: "any `export interface X {}` + `export function f(): X` pair in one file, move `f` elsewhere."

Sibling post-condition defects on the same op family: [[t-701638]] (stale prose naming the old path), and the move_file specifier-form defect where the applied edit fails the repo's own lint gate under the same `typecheck=clean` verdict.
