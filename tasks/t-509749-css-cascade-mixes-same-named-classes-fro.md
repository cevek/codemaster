---
id: t-509749
title: css_cascade mixes same-named classes from unrelated CSS modules into the per-property winner column — the one line a reader takes at face value is the one most often about another element
status: backlog
priority: high
tags:
  - agent-surface
  - dogfood
  - scss
type: bug
complexity: M
area: scss
source: dogfood-inbox-aug
relates:
  - t-706879
surface:
  - format
  - plugins/scss
audience: external
evidence: reported
created: '2026-08-08T12:00:28.353Z'
---
`css_cascade {file, class}` collects every rule that mentions that class NAME across every scanned sheet, and ranks them into one cascade. In a CSS-modules repo that is wrong by construction for any common name: a `.group` in `avatar.module.scss` compiles to a different runtime class and can never reach the element, yet it is ranked against the local `.group` and can WIN the per-property line. The answer's note states the scoping caveat honestly, so no claim is false in isolation — but the shape of the answer defeats it: the per-property `winner` is the one line a reader takes at face value, and it is the part most often about a different element.

Two things are wrong together:
- **Confidence vocabulary.** A cross-module same-name rule is marked `partial`, which reads "incomplete", not "this line is probably about another element". Rules that cannot apply need their own marker (`cannot-apply` / `same-name-elsewhere`), because the reader's remedy differs: `partial` says "look for more", the truth says "discard this row".
- **Default scope.** The rules that CAN apply — same sheet, `:global(...)`, and whatever `composes:` reaches — are the answer; cross-module same-name matches belong behind a flag or in a separate `sameNameElsewhere:` section, never inline in the winner column.

Consequence in the field: the true local cascade is buried, the winner column is discarded wholesale, and the agent leaves for the browser's computed styles — the fallback codemaster exists to remove.

## Свидетельство

2026-08-04, external field report from `amiro` (worktree `form-refusal-contract`), cm=0.1.0. Same call as [[t-706879]]: `css_cascade {file:'src/components/ui/input-group.module.scss', class:'group'}`, 472 sheets scanned, 13 rules that can actually apply, 15 listed, 25 properties reported — of which 9 name a cross-module winner:

- `display` → `src/components/ui/avatar.module.scss:115` = flex
- `width` → `src/components/inputs/ExpandingSearch/ExpandingSearch.module.scss:20` = 220px
- `overflow` / `padding` / `color` → `command.module.scss`
- `scroll-margin-top` / `scroll-margin-bottom` → `select.module.scss`
- `gap` → `EmailTemplatesView.module.scss`
- `flex-shrink`

Reporter: "I read it, discarded it, and went to the browser's computed styles instead." Track context: unifying an errored-control look across 8 painters — every question of the form "which element paints this box / who else defines this property for real".

Adjacent, not a duplicate: [[t-237692]] is the same flat-global-pool shape in `find_unused_scss_classes` (there it produces a false NEGATIVE); this is the cascade side, where it produces a wrong winner.
