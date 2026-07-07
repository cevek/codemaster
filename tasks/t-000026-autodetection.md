---
id: t-000026
title: autodetection
status: backlog
priority: low
tags:
  - dogfood-jul
type: feat
importance: low
complexity: S
area: phase-4
created: '2026-07-08T00:00:25.000Z'
---
**autodetection** — presence of dep in `package.json` + config gate. `feat`·`low`·`cx:S`

---
**Dogfood-jul (2026-07): concrete repro of the missing autodetect.** Inbox entry 49 — on
`claude-ui` (Vite + React 18 + TSX per its CLAUDE.md) `status` reports only `ts@0.1.0 · scss@0.1.0`;
the `react` plugin is NOT active, so `list components`, `trace_prop_through_tree`,
`find_unused_props`, react-query `invalidations_for` etc. are all gated off (the `ts` plugin still
does some JSX via `find_usages role:jsx`). The react plugin DOES activate on other repos
(`backoffice2` shows `react@0.1.0`), so this is the autodetect gate not firing on a `react` dep +
`.tsx` project — this task. (Note the week-plan cut Phase 4 breadth; this is the narrow
autodetect-parity slice, not the full framework-plugin buildout.)
