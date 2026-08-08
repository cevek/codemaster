---
id: t-563752
title: 'The from/to alias fix stopped short of the symbol relocations: move_symbol still rejects `from`, extract_symbol rejects both `from` and `to` — the guess-and-fail cost lands on the ops whose next step is 9 mutating calls'
status: backlog
priority: high
tags:
  - dogfood
  - intake
type: dx
complexity: S
area: ts-refactor
source: dogfood-inbox-aug
relates:
  - t-424583
surface:
  - ops
audience: external
evidence: repro
created: '2026-08-08T12:02:43.284Z'
---
`from`/`to` is the arg vocabulary every move tool in the world uses, and the intake normalizer maps it for `move_file` (`from→source`, `to→dest`) and half-maps it for `move_symbol` (`to→dest` only). The symbol relocations are still not covered:

- `move_symbol {name, from, to}` → `bad_args: unrecognized 'from'`. `move_symbol` has no source-path argument, so `from` is not a missing alias for one — it is the caller pinning the symbol's own file, i.e. `from → file`, the `name`+`file` addressing the op already accepts and recommends in its own ambiguity refusals.
- `extract_symbol {name, to}` → `bad_args: dest: expected string; unrecognized 'to'` — no alias at all, on the one relocation whose destination is BY DEFINITION new and therefore the one a caller reaches for after `move_symbol` refuses a non-existent `dest`.

The cost is not the one rejected call. It lands at the moment the caller has just been told to compose `extract_symbol` + N `move_symbol` calls inside a `transaction` against a dirty worktree — a chain of mutating calls whose arg shapes they have just discovered they were guessing wrong about. In the field that is where the tool was abandoned for a hand-written file plus a regex import rewrite.

Ask: `from→file` + `to→dest` on `move_symbol`, `from→file` + `to→dest` on `extract_symbol` (disclosed per-call via `Result.intake`, canonical schema still the sole gate). Plus, since the documented answer to the commonest reason anyone moves symbols is a composed chain, `status {op:'move_symbol'}` should carry a worked `extract_symbol → move_symbol → transaction` example with real args.

The `dest`-must-exist refusal itself is honest and already names `extract_symbol` as the remedy (verified on current `main`); the missing single-call "promote N symbols into a NEW module" is [[t-000107]].

## Свидетельство

2026-08-03, external field report, `amiro` worktree `qa-team-calendar`, cm=0.1.0. Real task: promote a 9-symbol slice (`ASSIGNABLE_ROLE_CODES`, `ClinicOption`, `clinicOptionsFrom`, `specificClinicIds`, `accessGrantsFrom`, `accessClinicsFrom`, `AccessFormFields`, `hasAnyAccessGrant`, `toggle`) out of `src/features/team/TeamMemberDetailPanel/model.ts` into a new `src/features/team/access-model.ts`, leaving the panel-private rest behind — the exact case the op map advertises. First call `move_symbol {name, from, to, apply}` → `bad_args: unrecognized 'from'`. Fallback: hand-written destination file + `git mv` + a throwaway python regex rewrite of import lists across 9 files. Reporter: "it worked — typecheck green — but it is precisely the manual import editing the tool exists to prevent, and a regex over import statements is exactly the thing that silently misses an aliased or re-exported symbol. I got lucky that this repo forbids barrels."

Verified on current `main` (2026-08-08, CLI one-shots): `move_symbol {name, from, to}` → `unrecognized 'from'`; `extract_symbol {name, to}` → `unrecognized 'to'`. [[t-424583]] (done) fixed `move_file` and predicted "likely move_symbol too" — this is that residual, now with a field report attached.
