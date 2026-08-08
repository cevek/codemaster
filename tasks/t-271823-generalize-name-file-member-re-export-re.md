---
id: t-271823
title: Generalize name+file member/re-export resolution into the shared resolveTarget (find_definition / expand_type still dead-end on a member)
status: backlog
priority: high
tags:
  - agent-surface
  - dogfood
  - dogfood-aug
type: feat
complexity: M
area: ts-core
source: dogfood-inbox-aug
audience: external
evidence: reported
created: '2026-07-15T13:20:37.906Z'
---
t-755152 added a member / re-export fallback to `find_usages {name,file}` at the OP level (`ops/find-usages-member-fallback.ts` + `ts.membersNamedInFile`): when no TOP-LEVEL declaration of `name` lives in `file`, it resolves a class/type MEMBER, enum member, or re-exported binding and re-issues by position.

That fallback is find_usages-scoped by design (boundary: the shared `plugins/ts/resolve-target.ts` `resolveNameInFile` is track A / ts-target territory). So the SAME name+file addressing still dead-ends with "no top-level declaration named X" on the OTHER symbol-addressed ops — `find_definition`, `expand_type`, `construction_sites`, `impact`, etc. — which funnel through `resolveNameInFile`.

**Ask.** Lift the member/re-export resolution into `resolveNameInFile` (or a shared step it calls) so every symbol-addressed op benefits uniformly, then drop the op-level fallback in favor of the shared one. Keep the honest disclosure (a member is not the top-level the agent addressed) and the >1 pick-list. The engine already exists (`ts.membersNamedInFile` / `nonTopLevelDeclarationsNamed`) — this is a relocation + wiring across ops, not new capability.

Reference: t-755152 (find_usages member fallback, DONE).

## Message wording

The dead-end this task quotes now reads `could not anchor a top-level declaration named 'X' in
<file> — …` (`src/plugins/ts/resolve-target.ts`). The old `no top-level declaration named 'X'`
string no longer occurs anywhere: the resolver reports what it could not ANCHOR, because that
walk is blind to a top-level binding pattern / namespace import-export / object-literal property
(t-561552), so an absence claim would be false for those shapes. Grep for `could not anchor`.

## Свидетельство (field report, 2026-08-07, /Users/cody/Dev/backoffice2) — priority low → high

External agent, pnpm monorepo. In this repo the entire API contract lives in generated
`clients/openApiSchemes/*/openapi.d.ts` as `components["schemas"]["<Name>"]` members, consumed as
`GatewayBookingSchemas["BookingHistoryItemResponseDTO"]`. These are the single most important types to inspect
when wiring a backend field to UI — and none of them is a top-level declaration, so none is addressable.

    expand_type {name:"BookingHistoryItemResponseDTO"}
    → FAIL tool=ts-ls — no symbol named 'BookingHistoryItemResponseDTO'

The fallback the agent tried is worse than the failure: `expand_type` at the consuming position (the
destructured binding in `const { id, createdAt, actor, actionType } = bookingHistoryItem`) returned
`about=const actionType: any` — silently useless rather than an honest FAIL. Ground truth, obtained by
grepping the generated `.d.ts` in one call: a 15-member string-literal union.

Priority raised because of what this addressing gap costs where it bites: for an openapi-typescript repo it is
not one member on one type, it is EVERY type the backend defines. "What does the backend actually send" — the
most frequent question before relying on a field — has no codemaster path, and the fallback is the grep the
tool description asks the agent to avoid.

### One addressing shape this task does not yet cover

The instance above has no FILE to pin: the caller knows the member name and the schema-holder name, not the
generated file. So beyond lifting member resolution into `resolveNameInFile`, the field asks for either
`expand_type {name:"GatewayBookingSchemas", member:"BookingHistoryItemResponseDTO"}` or acceptance of a type
EXPRESSION resolved through the checker
(`GatewayBookingSchemas["BookingHistoryItemResponseDTO"]["platform"]`). Decide that deliberately with the
name+file lift — a member fallback keyed on `file` alone leaves this repo shape unserved.
