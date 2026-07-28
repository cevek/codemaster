---
id: t-213394
title: six ad-hoc "is this a function boundary" predicates in plugins/ts — compose them on the new ast-node isFunctionCore instead of re-deriving
status: backlog
priority: low
tags:
  - debt
type: imp
complexity: S
area: ts-core
created: '2026-07-28T07:24:13.341Z'
---
Six hand-written kind-lists answer "is this node a function boundary", each with a different member
set: `jsx-return.ts` `isFunctionLike` (6) · `scope-shadow.ts` `functionLikeParameters` (7) ·
`type-widening.ts` `enclosingFunction` (5, no set-accessor — a setter has no return type) ·
`first-param-members.ts` (4) · `jsx-child-sites.ts` (4) · `call-condition-chain.ts`
`isFunctionBoundary` (now composed).

The divergences are DELIBERATE and merging them into one predicate would change behaviour at several
call sites — so the fix is not one shared predicate but the shared CORE plus per-caller extras.
`src/plugins/ts/ast-node.ts` now exports `isFunctionCore` (the four unarguable kinds: function
declaration / function expression / arrow / method) and `call-condition-chain.ts` composes on it
(`isFunctionCore(n) || ts.isConstructorDeclaration(n) || accessors || ts.isClassLike(n) ||
ts.isSourceFile(n)`).

Remaining: point the other five at `isFunctionCore` + their own extras, preserving each one's current
member set exactly (a behaviour-preserving refactor — verify per call site, don't normalise). Also
prefer the `...Declaration` spelling for accessors so the family stays greppable.
