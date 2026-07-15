---
id: t-811470
title: Ambiguity FAIL lists candidates as file:line:col — print the canonical `ts:Name@file:line:col~hash` SymbolId too, so the agent copies it verbatim instead of re-hitting "is not a SymbolId"
status: backlog
priority: low
tags:
  - dogfood
type: dx
complexity: S
area: render
source: dogfood-jul
created: '2026-07-15T12:19:37.334Z'
---
## Verified (codemaster usage/fail.jsonl)
Agents took a `file:line:col` from an ambiguity candidate list and passed it back as `symbolId`, getting a FAIL:
- `find_usages {name:'employeeUuid', symbolId:'src/stores/calendar.store.ts:11:5', …}` (amiro) → `'src/stores/calendar.store.ts:11:5' is not a SymbolId (those look like 'ts:Name@file:line:col')`.
- `find_usages {symbolId:'apps/kalendarik/src/containers/BookingDoctorSelect/BookingDoctorSelect.tsx:12:14'}` (backoffice2) → same.

## Fix (render half — the leverage point)
The ambiguity FAIL lists candidates as bare `file:line:col`, which is NOT directly reusable — neither as `symbolId` nor as a single arg. If the candidate list instead printed the CANONICAL `ts:Name@file:line:col~hash` SymbolId, the agent copies it verbatim into `symbolId` and the round-trip disappears at the source.

## Scope note
The COMPLEMENTARY intake half — accept a bare `file:line:col` as a location arg (relativize into file+line+col) — is arg-shape / intake and belongs to the separate bad_args triage, NOT here. This task is only the output-render fix (emit the copy-pasteable SymbolId in the candidate list).

Archive source: 2026-07-06 (line 380). Related: t-262491 (ambiguity handling), t-424583 (intake, DONE).
