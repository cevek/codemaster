---
id: t-631139
title: construction_sites ranks vacuous `any`-typed literals alongside proven ones and lets them consume the whole output budget — the op self-labels them unprovable, then buries the real sites behind them
status: backlog
priority: high
tags:
  - agent-surface
  - dogfood
  - dogfood-aug
type: bug
complexity: M
area: impact-usages
source: dogfood-inbox-aug
relates:
  - t-000140
  - t-162650
surface:
  - ops
  - plugins/ts
audience: external
evidence: reported
created: '2026-08-08T12:00:46.300Z'
---
`construction_sites` answers "what builds type T" by structural assignability. A literal whose own type is
`any` is assignable to EVERYTHING, so on a repo where `any` literals are common the result set is dominated
by object literals from packages that cannot construct T at all.

The op already knows these prove nothing — it annotates each such row
`dynamic · the literal's type is 'any' — assignable to any type vacuously, not a proven construction of T`.
It then ranks them level with proven constructions and lets them spend the response budget, so the answer
hits `!! OUTPUT CAPPED` before a single real site is printed. The result is an op whose stated purpose
(pre-edit blast radius: "which literals must gain this new required field?") is answered strictly worse than
one `git grep` line, and answered in a way whose emptiness is invisible: the page is full, so nothing signals
that the real sites are the ones that were cut.

This is a RANKING defect on top of an honest annotation, not a wrong verdict — which is why it survives the
§3.4 truncation contract: `shown/total` is correct, and it is still useless.

## What is missing

1. Vacuous rows do not compete with proven ones for the budget — sort last below a fold, or suppress by
   default with a tail line (`N vacuous \`any\` literals suppressed; includeVacuous:true to see them`), so the
   honesty channel survives without consuming the answer.
2. An explicit lever either way (`excludeVacuous` / `provenOnly` / `includeVacuous`), so the caller can ask
   the useful question in one call instead of guessing a `pathInclude`.
3. Same-package ranking: for a target declared under `apps/emr`, sites in `apps/attraction` are almost
   certainly noise and should not out-rank sites in the target's own package.

A caller cannot reach the answer today without ALREADY knowing which directory to scope to — which is the
question they came to ask.

## Свидетельство (field reports)

Two independent reports, same repo shape (`/Users/cody/Dev/backoffice2`, pnpm monorepo, 12 apps), 2026-08-07:

- `construction_sites {name:'MedicalEntryWorkflowContextValue', verbosity:'normal'}` (target
  `apps/emr/src/containers/MedicalEntryWorkflowV2/MedicalEntryWorkflow.types.ts:46`) → **205 sites, OUTPUT
  CAPPED at 18941/65664 chars**. Every visible row was `any`-vacuous and came from apps/attraction,
  apps/clinics, apps/companies, apps/employees. The two real sites (the JSX provider value in
  `MedicalEntryWorkflow.tsx`, an inline literal in `MultimediaForm.test.tsx`) never appeared before the cap.
  Motivation was a real semantic conflict between two merged PRs (one made `submittedStep` required, the
  other left a stale inline literal). Agent fell back to `git grep` + a full `tsgo --noEmit`.
- `construction_sites {symbolId:'ts:BookingHistoryItem@apps/kalendarik/src/entities/bookingHistoryItems/types.ts:7:13'}`
  → **204 sites, OUTPUT CAPPED** (63149 chars, 19630 shown), essentially all `any`-vacuous rows from unrelated
  apps. Narrowing to `pathInclude:["apps/kalendarik/**"]` cut it to 24 sites of which **exactly one was real**
  (`prepareBookingHistoryItem`). Unfiltered signal-to-noise: **1 in 204**.

Both reporters are external agents working in a repo they do not maintain, so neither the config nor the
target's typing was theirs to change.

## Related

`t-000140` records the sibling vacuity cause — an ALL-OPTIONAL target type, which `{}` satisfies — with the
same symptom and the same suggested remedies (demote / rank by field overlap). Two causes, one fix surface:
whatever suppresses or ranks a vacuous match should be defined over "this match proves nothing about T",
not over `any` alone.
