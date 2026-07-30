---
id: t-342283
title: No op finds a dead MEMBER of a context / plain-object value — find_unused_props covers component props only, knip cannot see it, and the grep fallback can produce a false 'dead'
status: backlog
priority: medium
parent: t-560034
type: feat
complexity: M
area: framework
source: dogfood-jul
relates:
  - t-585566
  - t-803574
surface:
  - src/ops/find-unused-props.ts
audience: external
evidence: repro
created: '2026-07-30T11:18:48.235Z'
---
## Repro (/Users/cody/Dev/amiro) — a dead member that is a live security wire

`PatientRecordView.tsx:253` declares `updateAppointmentStatus`, puts it on the patient-record context value
(`:337`), and NOTHING reads it. It is dead — and not harmlessly: it calls `useTransitionAppointment` with
ANY status including CANCELLED, i.e. a ready-made second path around the CANCEL_PAID_APPOINTMENT gate that
was just built. The day someone wires it to a button, the gate is bypassed.

Nothing in the toolchain finds it:
- `find_unused_exports` — it is not an export, it is a property of an object literal.
- `find_unused_props` — scoped to "declared props of a React component that no JSX call-site passes". A
  context value is structurally the SAME question (declared members vs read sites) and is out of scope.
- `member_usages` — needs a declared member on a checker-resolvable type; this context type is
  index-signature-open, so it FAILs (filed separately).
- knip — same blind spot: a field of a context object is not an export.

The actual method used was `grep -rn "updateAppointmentStatus" src` — which here is also UNSOUND: an
aliased read (`const {updateAppointmentStatus: fn} = usePatientRecord()`) would not appear under that name
at the read site, so a clean grep can be a false "dead".

## Ask

Extend the dead-code family to members of a VALUE object: "declared/assigned members of this object (or of
this type) that no site reads", read/write-classified like `member_usages`, with the same partial/dynamic
honesty when a consumer destructures dynamically or the type is index-signature-open. React context values
are the high-value instance (they are how that repo passes cross-cutting state, and every dead field there
is a live wire someone will later connect); the same shape covers store slices and returned facade objects.
