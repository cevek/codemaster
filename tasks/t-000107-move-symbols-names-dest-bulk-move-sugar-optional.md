---
id: t-000107
title: move_symbols({names:[],dest})` bulk-move sugar (optional)
status: backlog
priority: high
tags:
  - dogfood
type: feat
complexity: M
area: ts-refactor
relates:
  - t-808789
surface:
  - ops
audience: external
evidence: reported
created: '2026-07-08T00:01:46.000Z'
---
**`move_symbols({names:[],dest})` bulk-move sugar (optional)** — dogfood ask: splitting a large
file means moving N top-level symbols into one dest. The underlying need (one §2.8 gate, atomic,
importers repointed once) is now MET by a `transaction` whose steps are N `move_symbol`s. A
dedicated bulk op would only save the agent from authoring the steps array — pure ergonomics, not
a capability gap. Defer unless the transaction form proves too verbose in practice. `feat`·`low`·`cx:M`

## Свидетельство (dogfood-inbox, 2026-08-03, external)

`amiro` worktree `qa-team-calendar`, cm=0.1.0. The refactor was a 9-symbol promotion out of `src/features/team/TeamMemberDetailPanel/model.ts` into a NEW `src/features/team/access-model.ts` (`ASSIGNABLE_ROLE_CODES`, `ClinicOption`, `clinicOptionsFrom`, `specificClinicIds`, `accessGrantsFrom`, `accessClinicsFrom`, `AccessFormFields`, `hasAnyAccessGrant`, `toggle`), leaving the panel-private rest. The documented path — `extract_symbol` to birth the file, then 8 `move_symbol` calls inside a `transaction` — was 9 mutating calls against a worktree with uncommitted review fixes, and the agent abandoned the tool for a hand-written destination file + `git mv` + a python regex rewrite of import lists across 9 files.

So this is not sugar: "promote this slice into a new module" is the single commonest reason anyone moves symbols at all, and the composed chain is expensive enough at that arity that the tool loses to a regex — the failure mode the reporter names ("a regex over import statements silently misses an aliased or re-exported symbol") is exactly what codemaster exists to prevent. Priority raised low→high on that field report. Sibling residual on the same call: [[t-563752]] (the `from`/`to` intake aliases the relocations still reject).
