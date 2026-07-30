---
id: t-934520
title: member_usages FAILs with 'has no member X' on an index-signature type — asserting an absence the analysis does not support — and the message drops the intersection's other half
status: backlog
priority: high
parent: t-151992
type: bug
complexity: S
area: impact-usages
source: dogfood-jul
relates:
  - t-323725
  - t-342283
  - t-675220
surface:
  - src/ops/member-usages.ts
audience: external
evidence: repro
created: '2026-07-30T11:18:47.822Z'
---
## Repro (/Users/cody/Dev/amiro)

    member_usages {name:'PatientRecordContextValue', member:'updateAppointmentStatus'}
    → FAIL tool=ts-ls — type 'Record<string, unknown>' has no member 'updateAppointmentStatus'
      + the standard "blocked or missing a capability? file it" line

The declaration (`src/features/patients/PatientRecordView/context/PatientRecordContext.tsx:12`) is:

    export type PatientRecordContextValue = Record<string, unknown> & { … };

## 1. Wrong verdict shape (never-lie)

For a type carrying an index signature, "has no member X" is FALSE — every string key is structurally a
member, and the field really is passed at the provider call site (`PatientRecordView.tsx:337`) and read via
`usePatientRecord<T>()` destructuring. The honest answer is `partial`/`unresolved`: the member is not
DECLARED, the type is index-signature-open, so member identity cannot be checker-resolved — fall back to
text search. As written it asserts a claim the analysis does not support and then invites a bug report for
a known limitation. §3 makes `partial`/`unresolved` the way to say "incomplete" and FAIL the way to say
"could not do it"; this is the latter dressed in the former's conclusion.

## 2. The message drops half the type

It names the resolved type as `Record<string, unknown>` when the declaration is
`Record<string, unknown> & {…}`. A reader concludes the type is a bare Record and that their name resolved
to something unrelated. Print the intersection (or at least `… & {…}`) so the diagnosis points at the index
signature, which is the actual cause.

Cost observed: one wasted call plus a detour to re-derive the type by hand, then a grep fallback.
