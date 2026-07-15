---
id: t-584829
title: 'LOWER-BOUND "undiscovered program NOT loaded" note: collapse the repeated multi-line boilerplate to a one-line tag after its first full appearance per session, and surface a usage COUNT for the undiscovered programs (not just a warning)'
status: backlog
priority: medium
tags:
  - dogfood
type: imp
complexity: M
area: render
source: dogfood-jul
created: '2026-07-15T11:32:31.043Z'
---
On a repo with an unloaded sibling tsconfig, EVERY find_usages/importers_of appends the same multi-line `!! LOWER BOUND — N repo tsconfig(s) NOT loaded (…)` + `allProgram` explainer. Correct and useful the first time; on back-to-back queries in one session it's pure noise that crowds out the actual enclosers — especially for symbols the agent already knows are subproject-only.

**Two asks (either/both):**
(a) Collapse the repeated boilerplate to a one-line `(lower-bound: <config> unloaded)` tag after its first full appearance in a session; keep the full explainer once.
(b) Surface a COUNT for undiscovered-program usages, not just a lower-bound warning — i.e. actually search the named programs (or say how many hits they hold) so the caller gets a number instead of "do not trust this count". Where auto-loading the sibling is cheap, resolving the caveat to a complete count is the stronger fix.

Low severity — output signal-to-noise, not correctness (the note itself is honest).

Inbox source: 2026-07-14 (lines 348 / 355).
