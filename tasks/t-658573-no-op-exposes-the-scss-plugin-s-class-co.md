---
id: t-658573
title: 'No op exposes the scss plugin''s class→consumer mapping: "which sites carry this class" is computed inside find_unused_scss_classes and unreachable, so a global-class edit is scoped by grep'
status: backlog
priority: high
tags:
  - dogfood
  - scss
type: feat
complexity: M
area: scss
source: dogfood-inbox-aug
surface:
  - ops
  - plugins/scss
audience: external
evidence: reported
created: '2026-08-08T12:00:48.697Z'
---
`find_unused_scss_classes` already computes, per class, the set of consumer sites that keep it alive — `s.foo` member accesses plus global string classes in `className` / `clsx` literals. Only the NEGATION of that mapping is public (the classes with an empty site set). The forward direction — given a class, list its consumer sites — has no op, so the question "who uses this class, i.e. what breaks if I change this rule" has no codemaster answer at all:

- `find_usages` is symbol-anchored and cannot see a string-literal `className="panel"`;
- `css_cascade` answers the SHEET side (which rules target the class) and is silent on consumers;
- `scss_classes` lists declarations in a sheet, not their uses.

Ask: expose the existing mapping as its own op — `scss_class_usages {class, file?}` — returning consumer sites with proof spans and the same partial/dynamic honesty the dead-class verdict already carries (a computed/interpolated className is `dynamic`, a flat global pool with no per-sheet attribution is `partial`, cf. [[t-237692]]). `file` narrows a module-scoped class to its owning sheet; omitted, the class is treated as a global name.

Scope note: this is the SCSS-plugin inverse mapping, not a JSX-attribute question — the same site set the dead-class verdict is derived from, published forward. It must stay honest about the two surfaces it joins (member access on an imported module object; string literal for a global class), since only the first is semantically resolved.

## Свидетельство

2026-07-31, external field report from `/Users/cody/Dev/task-manager` (React + SCSS-modules web app), cm=0.1.0, plugins ts+scss.

Task: moving a layout element; before changing the global `.panel` rule in `globals.scss` the agent needed the JSX call sites carrying `className="panel"`. `css_cascade {selector:'.panel'}` answered the sheet side well (selector mode across 44 sheets, specificity + winner per property) and nothing answered the consumer side. Wanted: `scss_class_usages {class:'panel'}` → `web/src/app/Workspace.tsx:191:16 <aside className="panel">`. Fallback: grep — "which is exactly what codemaster is meant to replace, and grep on a word like `panel` is drowned in prose/comments."
