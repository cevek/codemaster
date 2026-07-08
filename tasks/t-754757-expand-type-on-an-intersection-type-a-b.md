---
id: t-754757
title: expand_type on an INTERSECTION type (A & B) flags every member as (inherited) — getSymbol() undefined → empty ownDecls
status: backlog
priority: medium
type: bug
complexity: S
area: correctness
source: dogfood-jul
created: '2026-07-08T11:20:22.690Z'
---
Pre-existing (untouched by t-000160's fix). expand_type on an intersection type A & B: type.getSymbol() returns undefined → ownDecls empty → the isInherited containment check finds no ancestor in ownDecls → EVERY member falsely flagged (inherited). Same class as the namespace-merge bug fixed in t-000160(e) but a different root (no symbol → no own decls). Fix: derive ownDecls for an intersection from its constituent types' symbols/declarations.
