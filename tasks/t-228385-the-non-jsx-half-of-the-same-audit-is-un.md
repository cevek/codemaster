---
id: t-228385
title: 'The non-JSX half of the same audit is unexpressible: no op answers "which call sites pass `{variant:''contained''}` to cva() / createElement(C, {…}) / a factory" — construction_sites needs a NAMED type, these configs are inline literals'
status: backlog
priority: high
tags:
  - agent-surface
  - dogfood
type: feat
complexity: M
area: impact-usages
source: dogfood-jul
created: '2026-07-28T16:38:52.435Z'
---
Found by the worker that shipped the JSX half (t-109741), looking at the op set from the position of
"what is missing here".

`find_usages {props:{…}}` now answers "which `<X …/>` sites pass this prop". The mirror question has no
answer: **which CALL sites pass `{variant:'contained'}`** to `cva(...)`, `createElement(C, {...})`, or a
config factory.

Why nothing covers it:
- `construction_sites` requires a NAMED type target, and these configs are inline object literals with no
  named type to address — the identical reason `member_usages` failed the amiro reporter on
  `UseMutationResult` (t-340801) and on an inline props type (t-109741).
- `find_usages` on the factory gives call sites but says nothing about the argument's shape.

**The audit is not JSX-specific, and that is the point.** "Who opts out of this default / who selects this
variant" is one question that a design system expresses as a PROP and a headless library expresses as a
CALL ARGUMENT. Today exactly half of it is queryable, and which half depends on a styling convention the
question does not care about. Both instances that put a wrong number into a shipped artifact (t-109741)
were the prop half; the call-argument half has simply not been attempted, not proven safe.

Machinery already exists in the ts plugin: `callArgShapes` and `literalCalls` are whole-program syntactic
scans keyed on `projectVersion()`, i.e. the same class of reader the JSX work just consolidated
(`jsxSiteAttrs` became the single home, with `jsxCallSites` a projection over it — do the same here rather
than adding a third reading of "what does this site pass").

Honesty requirements carry over unchanged from the JSX half: three states (literal / dynamic expression /
opaque spread), the dynamic value carried WITH its source text and never dropped, spread ORDER respected
where the language has last-writer-wins semantics, and the two uncertainties counted apart because their
remedies are different reads.
