---
id: t-706879
title: css_cascade drops declarations that arrive via @include — the winner list silently omits mixin-expanded properties
status: backlog
priority: high
tags:
  - dogfood
  - scss
type: bug
complexity: M
area: scss
source: dogfood-inbox-aug
surface:
  - plugins/scss
audience: external
evidence: reported
created: '2026-08-08T12:00:08.490Z'
---
`css_cascade` reads the postcss CST syntactically and never expands `@include`. A rule whose whole declaration body comes from a mixin therefore contributes NO properties to the cascade: the rule is absent from the rule listing, and the per-property `winner` names a lower-specificity rule that the mixin-carried declaration actually overrides. Nothing in the output marks the omission — `confidence=partial` is emitted, but for the cross-module class-name-scoping caveat, so it reads as being about something else.

This is a silent completeness lie (§3.4), and worse than a FAIL: the op is asked "which rule paints this property, and does anything compete with it", and it answers with the winner deleted. In a repo whose shared control look is factored into mixins (`@include control.errored-states`), EVERY errored/hover/focus state of EVERY painter is invisible while the answer still reads complete.

Fix, either order:
- expand `@include` at analysis time when the mixin body is a plain declaration block resolvable through the sheet's `@use`/`@import` graph, and attribute the declarations to the including rule (provenance = the mixin's own `file:line`); or
- if expansion stays out of scope, emit the rule with an explicit per-rule `declarations: unresolved (@include <name>)` marker and demote every property whose winner could be shadowed by it — the omission must be VISIBLE, whatever the resolution.

A `@include` inside a rule is also a reason the RULE ITSELF must appear in the listing even with zero resolvable declarations: today the rule vanishes entirely.

## Свидетельство

2026-08-04, external field report from `amiro` (worktree `form-refusal-contract`, 129fd47a), cm=0.1.0.

`css_cascade {file:'src/components/ui/input-group.module.scss', class:'group'}` — the sheet holds, inside `.group`:

```scss
&:has([data-slot][aria-invalid='true']),
:global([data-field-slot][data-errored='true']) & {
    @include control.errored;   // border-color: var(--destructive); box-shadow: 0 0 0 2px color-mix(...)
}
```

Neither rule appears in the 15-rule listing. `border-color` / `box-shadow` winners are reported as the focus-visible rule (`[0,3,0] :has([data-slot='input-group-control']:focus-visible)` = `#111` / `rgba(17,17,17,.1)`) with no mention that an errored state overrides both. The mixin lives in `src/styles/form-control.mixins.scss`. Reporter: "the silent version is worse than a FAIL: I would have trusted a winner list that could not see the winner." Same shape for input, textarea, select, switch, checkbox, segmented-control, SelectableCard in that session.

Distinct from the same call's second defect (cross-module same-name attribution) — see [[t-000126]] for cross-file source order, which this does not depend on.
