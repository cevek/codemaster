---
id: t-962078
title: Cross-repo component style/variant survey — given a component symbol, enumerate its cva variant map AND the resolved style values per variant (Tailwind class → props, .module.scss class → declarations), side-by-side across two roots
status: backlog
priority: low
tags:
  - dogfood
type: feat
complexity: L
area: scss
source: dogfood-jul
created: '2026-07-15T11:33:18.420Z'
---
**Task shape.** Survey every Button/Input/Label variant+style in a design repo (Tailwind/cva) and diff against another repo's equivalents (SCSS modules). codemaster's TS-symbol strengths didn't help: (1) the design repo isn't a warm root (needs indexing via `root`); (2) the visual contract lives in Tailwind utility strings / .module.scss property values, not TS types — so the agent fell back to raw cross-repo Read on ~15 files.

**Ask.** A capability that, given a component symbol, enumerates its cva variant map AND the resolved style values per variant (Tailwind class → computed props, or .module.scss class → declarations), ideally side-by-side across two roots — turning a manual multi-file read into one op. Related: a `scss_classes`-style op for "the effective box model (height/radius/padding/font/colors) of variant X of component Y". Design-parity audit is the driving use case.

Inbox source: 2026-07-12 (line 253).
