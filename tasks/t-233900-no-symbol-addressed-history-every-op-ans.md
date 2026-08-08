---
id: t-233900
title: 'No symbol-addressed HISTORY: every op answers about the current tree, so "did this get fixed or did the subject move out from under me" and "which commit made F a call site of S" both fall back to `git log -S` — the textual incompleteness codemaster exists to replace'
status: backlog
priority: high
tags:
  - agent-surface
  - dogfood
type: feat
complexity: L
area: impact-usages
source: dogfood-inbox-aug
relates:
  - t-089408
surface:
  - ops
  - plugins/ts
  - support
audience: external
evidence: reported
created: '2026-08-08T12:00:24.081Z'
---
Every op is addressed at HEAD. There is no op whose argument is a pair of revisions, so the whole temporal
class is served by `git log -S<identifier>` / `git log --follow` / `git diff` — TEXTUAL tools whose silent
incompleteness (aliased imports, re-exports, a call site that changed shape without changing the token) is
the exact reason the repo's own rules forbid grep for symbol questions. The graph at two revisions and a
diff of the site sets is the semantic part git cannot do: "this commit made file F a call site of symbol S"
is a reference-graph delta, not a string delta.

Two DISTINCT questions under one capability — a design must answer both, they are not paraphrases:

**1. What LEFT this file between two revisions** (the agent re-verifying its own earlier conclusion).
Shape: `symbols_moved {file | dir, since: <ref>}` → symbols that left / arrived, and where they went.
The reading it protects: a measurement that drops to zero after a rebase has two opposite explanations —
the defect was fixed, or the subject moved out of the observed surface — and they look identical. Both
routine checks ("is the defect gone?", "does the rule still work?") pass while explaining the zero wrongly.
This is the standing cycle of all multi-agent work here: conclude in an isolated worktree, rebase onto a
branch that moved, re-ask. Same question a human has on a release diff, where `git diff` shows a deletion
in one file and an addition in another as two unrelated facts.

**2. WHEN a reference edge appeared or disappeared** (attribution).
Shape: `history {name, role:'call', filter:{pathInclude}, since:<commit>}` → per commit: sites ADDED /
REMOVED / MOVED, carrying the same proof spans as every other op. Includes the smaller sibling of
`find_usages`: there is no "who STOPPED referencing X", which is the question behind every is-this-still-live
check — a defect closed by removing the last call site is indistinguishable from one that was never real.

Nearby ops that do NOT answer it: `affected` is changed-files → tests (the other side of the graph);
`find_usages` / `importers_of` are current-state only; `impact` is the blast radius of an edit not yet made.
The `handle: rebound` machinery (§6) already relocates a symbol across an edit — this is the same
relocation across commits.

## Свидетельство (field reports)

**2026-08-05, repo amiro-frontend — measured cost, wrong commit shipped.** An audit of ~40 tasks had to name
the commit that closed each one; the whole track ran on `git log -S`. Two commits were named as a task's
closure because they touched the FILE containing the mechanism; a reviewer ran `git log -S issueOn --follow`
and got exactly ONE, different commit whose body described the migration verbatim — the two named had only
removed unrelated defaults and widened a prop. Reporter's own framing: «a resolution naming the wrong commit
is worse than one naming none: the next reader follows it and reads a diff that does not contain the change.»

**2026-08-05, same repo — a false conclusion caught by luck.** A lint rule measured exactly one violation
(`useAddSaleData.ts:143`); after a rebase it measured zero. Truth was neither of the two binary readings: the
defect WAS fixed (migration to `useSuspense*`) and the `.filter` the rule inspects had simultaneously moved
into a helper (`buildAppointmentOptions`) in another module — the observed surface narrowed at the same time
as the fix. Found only because a positive control unexpectedly stayed silent, i.e. by accident, not by a check.

Two independent reports, two agents, one external repo; one of them cost a wrong fact in a report.
