---
id: t-847874
title: '`batch` under the size-guard: N requests fail with N identical refusals, `force` must be re-passed per request, and the suggested config fix ships no copy-pasteable snippet'
status: backlog
priority: medium
tags:
  - agent-surface
  - dogfood
type: dx
complexity: S
area: render
source: dogfood-jul
created: '2026-07-28T08:27:44.910Z'
---
First contact with backoffice2 (6101 files), three frictions in one round-trip:

1. A `batch` of 3 requests failed 3× with the byte-identical size-guard message — one round-trip wasted
   and the guidance text repeated verbatim per request. The guard is a REPO-level decision (t-544207
   measured that the cost is multi-program build, not per-target), so it could fail once at batch level.
2. `force` is a per-request arg, so recovering means editing every request in the batch. A top-level
   `force` on the batch — mirroring the existing top-level `root` — makes recovery one edit instead of N.
3. The message suggests `daemon.isolation:'process'` in codemaster.config, but `status` in that same repo
   says `config=defaults (no codemaster.config.*)` — so it names a file that does not exist without saying
   what a minimal one contains or where it goes. A one-line copy-pasteable snippet + path turns a docs
   hunt into a paste.

Point 3 overlaps t-959904 (refusals should name the working path) and is largely obviated by t-754922
(auto-escalation) — but 1 and 2 are independent ergonomics of the batch surface itself.
