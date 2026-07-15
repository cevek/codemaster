---
id: t-233427
title: "Empty-cwd UX: when cwd has zero tracked TS files, status hints 'cwd empty — pass root' instead of warming an empty workspace; and a way to set a session default root so cross-repo work doesn't repeat root on every call"
status: backlog
priority: low
tags:
  - dogfood
type: dx
complexity: M
area: platform
source: dogfood-jul
created: '2026-07-15T11:33:42.758Z'
---
Session cwd was an empty dir (no package.json, no TS); the real code lived in a sibling repo. Consequences: (1) had to pass `root` on EVERY op call since cwd had nothing to resolve against; (2) `status` reported the sibling workspace only because root was passed — the default warm root would have been the empty cwd.

**Asks.** (a) When cwd has zero tracked TS files, `status` hints "cwd empty — pass root to target a real repo" rather than warming an empty workspace. (b) A way to set a default root for a session so cross-repo work on one sibling repo doesn't repeat `root` on every call. Related: a `status` "TS source-file count / sources: 0 files" line (also raised in t-815425).

Inbox source: 2026-07-10 (line 133).
