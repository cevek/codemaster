---
id: t-246435
title: find_usages (proper) labels a destructure binding as write — the role classifier maps LS isWriteAccess; a destructure is a READ
status: done
priority: low
type: bug
complexity: S
area: impact-usages
source: dogfood-jul
created: '2026-07-08T19:29:02.797Z'
---
Flagged by t-000175. find_usages PROPER classifies a destructure binding ({x} = y) as write (its role classifier maps the LS isWriteAccess flag, which marks the binding a write). member_usages FIXES this in its own path (memberRefKind in member-refs.ts -> destructure), but find_usages is unchanged, so a field READ via destructure still reads as write there — wrong for a read-audit. Consider routing find_usages disposition through the same memberRefKind (read/write/destructure) shared core. fix-locus: src/plugins/ts/usages.ts role classifier + src/plugins/ts/member-refs.ts (reuse).
