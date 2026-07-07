---
id: t-709349
title: 'find_usages `text:true` (and doc-hygiene sweeps): filter literal-text hits by the AST node kind they land in — string/template literal vs comment/JSDoc'
status: backlog
priority: low
tags:
  - dogfood-jul
type: dx
importance: low
complexity: M
area: impact-usages
created: '2026-07-07T20:07:26.305Z'
---
Inbox entries 23, 188, 195 (`task-manager`), 2026-07-04. When sweeping a literal token (e.g. `§`, or a user-facing string) across a codebase, distinguishing "token inside an emitted string/template literal" from "token inside a code comment/JSDoc" is currently a manual, brittle `grep -v` on `//`/`*` prefixes. Ask: an op (or a flag on `find_usages text:true`) that filters literal-text hits by the AST node kind they land in — string-literal / template-literal expression vs comment/JSDoc — making doc-hygiene / user-facing-string sweeps precise. Low priority; grep sufficed there.
