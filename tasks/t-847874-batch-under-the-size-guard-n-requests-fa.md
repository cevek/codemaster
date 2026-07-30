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
relates:
  - t-187018
  - t-245013
  - t-544207
  - t-633403
  - t-702879
surface:
  - cli
  - mcp
  - ops/guard
audience: external
evidence: measured
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

**Related:** point 3 is t-245013's defect on the guard surface — the message names what is missing (a config file) without the means to act (what a minimal one contains, where it goes). The refusal TEXT home is t-633403; the subject-loss on the same path is t-702879.

## Field observation (dogfood-jul, /Users/cody/Dev/backoffice2, 6101 src files)

Same-session measurement adds a discriminating detail to the batch half: `search_symbol` **worked standalone
and failed inside a batch** on the same repo, in the same session. `symbols_overview`, `source`, `status` and
`feedback` also worked standalone, while `find_usages` / `find_definition` were refused. So the guards blast
radius inside a batch is wider than the set of requests that individually risk the warm — worth pinning
which of the two (per-request evaluation vs the batch envelope) actually decides.
