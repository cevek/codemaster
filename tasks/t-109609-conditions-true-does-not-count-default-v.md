---
id: t-109609
title: conditions:true does not count DEFAULT-value short-circuits (destructuring / parameter defaults) — disclosed as out-of-scope, not measured
status: backlog
priority: low
tags:
  - agent-surface
type: feat
complexity: S
area: impact-usages
created: '2026-07-28T07:46:54.381Z'
---
A default value evaluates ONLY when the target is `undefined`, so a call site inside one is
conditional — but `conditions:true` reports an empty chain for all three shapes:

    const { a = F() } = o;          → []   (fires only when o.a === undefined)
    const [q = F()] = arr;          → []
    function d(p: boolean = F()) {} → []   (fires only when the argument is omitted/undefined)

Currently handled by DISCLOSURE: the `conditions:true` scope note lists defaults among the shapes
outside the claim, which the contract permits (the producer decides what counts as a branch, and a
stated omission is honest — same as `for..of`). This task is the measurement.

Not a one-liner, which is why it was not done inline: the parameter case has an obvious guard text
(`p === undefined`), but a nested binding element needs the ACCESS PATH reconstructed from the
pattern (`const { a: { b = F() } } = o` → `o.a.b === undefined`), and a wrong path is a fabricated
fact about the code. Implement in `src/plugins/ts/call-condition-chain.ts` (`stepCondition`:
`ParameterDeclaration.initializer` / `BindingElement.initializer`), and — because the rule must be
validated by execution, not belief — add sites to `test/fixtures/inline/condition-runtime-sites.ts`
so the runtime oracle covers them (see that file's two soundness rules first).
