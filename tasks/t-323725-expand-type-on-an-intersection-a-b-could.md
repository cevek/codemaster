---
id: t-323725
title: expand_type on an intersection A & B could show MERGED members instead of just the constituents
status: backlog
priority: low
type: feat
complexity: M
area: impact-usages
source: dogfood-jul
created: '2026-07-08T12:37:11.938Z'
---
Enhancement flagged during t-754757. A bare intersection A & B currently renders its constituents (A, B) via the type-expand.ts:72 union/intersection dispatch, never reaching expandMembers. Nicer would be to show the MERGED member set (the effective properties of A & B). Not a lie (constituents are honest) — a density/usability enhancement. fix-locus: src/plugins/ts/type-expand.ts intersection dispatch.
