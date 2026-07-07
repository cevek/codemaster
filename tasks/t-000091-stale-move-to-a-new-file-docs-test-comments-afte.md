---
id: t-000091
title: stale "Move to a new file" docs/test comments after the extract action-switch
status: backlog
priority: low
type: dx
complexity: S
area: ts-refactor
created: '2026-07-08T00:01:30.000Z'
---
**stale "Move to a new file" docs/test comments after the extract action-switch** — the
action-switch (extract now drives "Move to file", not "Move to a new file") left present-state
drift: `docs/spec-extract-completion.md` (Status: proposed) still describes the RETIRED mechanism
("drives Move to a new file, post-processes specifiers") — retire or rewrite it, and re-verify its
KS-2 / KS-3 quarantine claims under "Move to file". Plus stale test comments naming the dead
action: `extract-symbol.test.ts`, `kitchensink-extract.test.ts`, `refactor-doc-adjacency.test.ts`,
`refactor-import-fold.test.ts`. `dx`·`low`·`cx:S`
