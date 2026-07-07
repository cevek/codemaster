---
id: t-513259
title: find_unused_scss_classes lists 100% of a GLOBAL (non-module) stylesheet's classes as unused-partial — string-literal classNames unresolved, reads as actionable dead code
status: backlog
priority: medium
tags:
  - UNVERIFIED
  - dogfood-jul
type: bug
importance: medium
complexity: M
area: scss
created: '2026-07-07T20:05:39.627Z'
---
Inbox entry 21 (`task-manager/t5-web/web`, Vite+React+SCSS SPA), 2026-07-04. One global `src/styles/app.scss` imported for side effects (`import './styles/app.scss'`); components apply classes via plain JSX `className` string literals (`<div className="board">`, `` className={`column${…?' column--unknown':''}`} ``). `find_unused_scss_classes` flagged **all 69 classes** unused, each `partial`, `globalModules=[app.scss]` — false positives (`board`/`card`/`overlay` are all live).

The op's status note now states the honest downgrade the entry asked for as a floor — a flat/global `.scss` "is referenced via string `className="foo"` codemaster cannot resolve, so its classes demote to partial". So the honesty contract holds. **But** it still enumerates every class as unused-partial, which is easy to misread as actionable dead code (the entry's core complaint).

Ask (either): (a) for a global (non-`.module.*`) sheet, resolve usage by scanning `className`/`class` string literals across the component tree — the static prefix of template-literal classNames + BEM `--modifier` concatenations — before reporting; or (b) suppress the per-class list and emit a single `cannot-resolve-global-usage` verdict for the sheet, so it can't be read as a dead-code list. UNVERIFIED on current `main` (needs a global-sheet + string-className fixture to repro; adjacent to scss tasks t-000123/125/127).
