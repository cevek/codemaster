---
id: t-675220
title: 'member_usages: an honest per-query complete=true composes into a dishonest field footprint when the same domain field lives on generated Create*/Update*InputDto twins'
status: backlog
priority: medium
parent: t-151992
type: imp
complexity: M
area: impact-usages
source: dogfood-jul
relates:
  - t-100043
surface:
  - src/ops/member-usages.ts
audience: external
evidence: measured
created: '2026-07-30T11:17:55.374Z'
---
## Measured (/Users/cody/Dev/amiro, contract migration: backend dropped `quantity` from the medication resource)

    member_usages {name:'MedicationDto', member:'quantity'}      → 10 sites, complete=true, notes (0)
    member_usages {name:'CreateMedicationInputDto', member:'quantity'} → 4 MORE sites
    member_usages {name:'UpdateMedicationInputDto', member:'quantity'} → 2 MORE sites

Each answer is correct by identity semantics — the first covers the RESPONSE type only. The write sites
that build request bodies live on the generated input twins, and nothing in the first answer says they
exist. A caller doing exactly the documented thing ("member question → member_usages") ships a migration
map missing every write path while reading `complete=true`.

This is structural in that repo, not incidental: `src/api/generated/api-input-types.ts` mechanically emits
`<Op>InputDto` aliases (`Parameters<typeof api.createMedication>[0]['data']`) per operation, so EVERY DTO
field has 1–3 same-named twins by construction. Resolution through those aliases already works.

## Two shapes, either helps

1. A note when the resolved member's owning type has same-named members on structurally-related sibling
   types in the workspace (cheap heuristic: identical member name + type names sharing a stem):
   `notes (1): 2 sibling types declare a 'quantity' member — CreateMedicationInputDto, UpdateMedicationInputDto. complete=true covers MedicationDto only.`
2. A LIST target, the way `find_usages` already takes `symbols: string[]`:
   `member_usages {symbols:['MedicationDto','CreateMedicationInputDto',…], member:'quantity'}`
   → one call, one honest completeness verdict.

`batch`+`sql` unions them today, but only once the caller already knows the twins exist — which is the
missing information.
