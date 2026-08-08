---
id: t-527328
title: i18n_lookup prints no freshness line on matched=0, so "this key does not exist" and "the index is behind your edit" are byte-identical answers
status: backlog
priority: high
tags:
  - dogfood
  - honesty
  - i18n
type: bug
complexity: S
area: i18n
source: dogfood-inbox-aug
surface:
  - format/render
  - ops
  - plugins/i18n
audience: external
evidence: reported
created: '2026-08-08T11:59:44.682Z'
---
A POSITIVE `i18n_lookup` answer carries its freshness (`freshness: reindexed 89 file(s) at entry
@fcabba415`). A MISS carries nothing:

```
defs (0):
usages (0):
locales (1):
  en
matched=0
```

The two states that block collapses are opposite in what the caller must do:
(a) the key genuinely does not exist — actionable ("this locale key is dead, delete the call site");
(b) the index has not caught up with edits made seconds ago — the caller must retry, not conclude.

An empty answer with no freshness reads as a completed, trustworthy search, so it is taken as (a). The
honesty contract everywhere else in codemaster is explicit about exactly this (`freshness: … PENDING N =
index behind, re-run`) — its ABSENCE on the empty answer is what makes the empty answer read as a claim
about the repo instead of possibly a claim about the daemon. A proof of absence is the one answer that
most needs its freshness stated.

Fix: emit the same freshness line (and PENDING when the index is behind) on `matched=0`.

## Свидетельство (2026-08-05, `amiro/forms-w2-editors` @ fcabba415)

Reported alongside a second-hand observation the reporter deliberately did NOT assert: a review subagent
in the same worktree reported `i18n_lookup` "returned matched=0 for keys that demonstrably exist,
including pre-existing ones", and fell back to grep for its whole i18n section. The reporter could not
reproduce afterwards (every key and prefix answered correctly, including one added minutes earlier), and
states plainly that the mechanism was not observed. What IS shown, and is the filed defect, is that the
answer gives the reader nothing to tell the two states apart. The concrete miss in the repro
(`settings.emailTemplatesPage.restore`) was a genuinely deleted key — that is the point: the deleted-key
answer and a stale-index answer are identical in shape.
