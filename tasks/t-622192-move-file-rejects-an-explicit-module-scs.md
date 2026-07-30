---
id: t-622192
title: move_file rejects an explicit .module.scss source as 'not in the workspace' though it moves that same file as a sibling companion — and the error sends the agent to git mv, which would race the companion move
status: backlog
priority: low
type: bug
complexity: S
area: ts-refactor
source: dogfood-jul
relates:
  - t-619235
  - t-701638
surface:
  - src/ops/move-file.ts
  - src/ops/transaction.ts
audience: external
evidence: repro
created: '2026-07-30T11:19:06.724Z'
---
## Repro (/Users/cody/Dev/amiro — every component is `X.tsx` + `X.module.scss`)

A `transaction` of 10 `move_file` steps listing each `.tsx` AND its `.module.scss` explicitly (the honest
reading of "move a file") failed:

    FAIL tool=transaction — step 1 'move_file' could not be planned: source not in the workspace:
    .../ChartItemPanel/MedicationPrescriptions.module.scss. Nothing written (no prefix applied).

Dropping the scss steps and moving only the 7 TS files worked — and the summary showed all three
`.module.scss` files moved anyway, as companions of their sibling `.tsx`. So the capability is there; only
the explicit-source path refuses it. The correct call and the incorrect call differ only by what the caller
happens to know about companion handling.

## Asks

1. Accept a `.module.scss` (or any sibling asset the mover already relocates) as an explicit `source` — at
   minimum as a NO-OP when another step in the same transaction already covers it.
2. Failing that, make the message say it: "scss moves as a companion of its sibling .tsx — drop this step".
   "source not in the workspace" reads as "does not exist / is untracked" and sends the agent to `git mv`,
   which would then race the companion move and leave a duplicate.

## Separate, smaller

The failing step was reported as "step 1" while it was the SECOND element of the array — a 0-indexed number
in a 1-indexed-sounding message. On a 10-step transaction that costs a re-read to locate.
