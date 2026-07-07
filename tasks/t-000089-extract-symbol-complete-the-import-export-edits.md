---
id: t-000089
title: "extract_symbol`: complete the import/export edits the LS leaves (KS-2/KS-3)"
status: backlog
priority: medium
type: feat
importance: medium
complexity: L
area: ts-refactor
created: '2026-07-08T00:01:28.000Z'
---
**`extract_symbol`: complete the import/export edits the LS leaves (KS-2/KS-3)** —
[spec-extract-completion.md](spec-extract-completion.md). Extracting a closure that captures a
type-only binding under `verbatimModuleSyntax` (the LS imports it as a value → §2.8 gate refuses)
and the sole-export-`Widget` case currently honestly REFUSE — pinned/quarantined in
`test/e2e/kitchensink-extract.test.ts`. Complete the edits so the extract succeeds cleanly.
`feat`·`med`·`cx:L`
