---
id: t-000067
title: "Cross-program capture detection is PRIMARY-only (all symbol-anchored ops)"
status: backlog
priority: low
type: bug
importance: low
complexity: M
area: multi-program
created: '2026-07-08T00:01:06.000Z'
---
**Cross-program capture detection is PRIMARY-only (all symbol-anchored ops)** — capture
detection (rename's `detectRenameCapture`; move/extract/move_symbol's import re-resolution) runs
over the PRIMARY program only, so a type-compatible silent re-bind the edit would cause in a
SIBLING program (a `test/**` site whose `newName` shadows an in-scope binding there, or a
rewritten import that lands on a different same-named sibling export) is NOT flagged. The
cross-program §2.8 gate still catches a resulting DANGLE/type error, but is blind to a same-typed
re-bind (the exact class the capture guard exists for — the same residual the codemod/transaction
capture gaps carry). Surfaced in every such op's notes ("cross-program LIMITS"). Fix: fan capture
detection across programs too. `bug`·`low`·`cx:M`
