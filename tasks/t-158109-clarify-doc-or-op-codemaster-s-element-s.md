---
id: t-158109
title: Clarify (doc or op) codemaster's element-selector / at-rule coverage vs CLASS coverage, so a 'use codemaster not grep' nudge can route bare element selectors (`.md hr`, blockquote) to grep instead of find_unused_scss_classes (which handles CLASS selectors only)
status: backlog
priority: low
tags:
  - dogfood
type: doc
complexity: S
area: docs
source: dogfood-jul
created: '2026-07-15T11:34:58.499Z'
---
A repo's PostToolUse:Bash hook fired a generic "use codemaster instead of grep" nudge on every grep, including cases the codemaster spec explicitly reserves for grep — literal non-symbol text (prose/log lines) and CSS ELEMENT selectors (`.md hr`). The nudge even suggested `find_unused_scss_classes`, which only handles CLASS selectors, not bare element selectors like `hr`/`blockquote`. So tool-selection guidance and codemaster's own "grep is correct for literal text" contract disagree at the element-selector / prose boundary.

**Codemaster-side ask (the hook itself is harness-side, out of scope).** A doc note (or a tiny op/status line) that states codemaster's SCSS coverage is class-selector-scoped — element selectors, at-rules, and bare-tag rules are NOT covered — so a nudge (or an agent) can distinguish "symbol/class question → codemaster" from "literal element-selector or prose → grep" instead of nudging uniformly.

Inbox source: 2026-07-10 (line 174).
