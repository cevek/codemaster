---
id: t-389688
title: 'importers_of/find_usages: surface a real usage COUNT for undiscovered programs (auto-load), not just the LOWER-BOUND warning'
status: backlog
priority: low
tags:
  - dogfood
created: '2026-07-16T10:30:55.505Z'
---
Split from t-584829 ask (b). The undiscovered-program floor notes (`!! LOWER BOUND — N repo tsconfig(s) NOT loaded …`) are honest but only WARN; they do not tell the caller HOW MANY usages/importers live under the unloaded programs. The stronger fix: where auto-loading the sibling is cheap, actually search the named programs and resolve the caveat to a COMPLETE count, so the agent gets a number instead of "do not trust this count".

This is a BEHAVIORAL change (auto-load siblings — overlaps the `programs:` lever's job), not an output-format change — hence split out of the render/truncation-foundation track (t-188210), which delivered only the stateless consolidation of the note prose.

NOTE — cold==warm-safe alternative if per-session dedup is ever revisited: a BATCH-scoped collapse (dedup the repeated note WITHIN one batch's results) is honest (a batch is one atomic read, same for cold and warm), unlike the session-scoped collapse rejected in t-584829 (which violates §16 invariant 3). Only pursue if the note noise proves painful in practice.

Source: 2026-07-14 dogfood inbox (lines 348/355), via t-584829.
