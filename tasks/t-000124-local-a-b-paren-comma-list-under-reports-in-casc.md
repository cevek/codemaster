---
id: t-000124
title: :local(.a, .b)` paren-comma list under-reports in cascade
status: backlog
priority: low
type: bug
complexity: M
area: scss
created: '2026-07-08T00:02:03.000Z'
---
**`:local(.a, .b)` paren-comma list under-reports in cascade** — a multi-subject `:local(...)`
unwraps to `.a, .b`, but `analyzeBranch` reads only the LAST compound's subject (`b`), so a
`css_cascade` query for target `a` emits no contribution from that rule → a wrong `certain`
winner for `.a` is possible ONLY if another same-specificity rule also targets `.a`. NOT a
regression (the multi-subject form was invisible before the `:local` fix too); the find_unused
side stays honest (`:local(.a, .b)` is not-owned → `partial`). Fix: split the unwrapped
`:local(...)` selector list into per-branch subjects. `bug`·`low`·`cx:M`
