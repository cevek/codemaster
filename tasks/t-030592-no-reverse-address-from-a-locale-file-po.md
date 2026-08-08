---
id: t-030592
title: No reverse address from a locale FILE POSITION to its dotted key — a key written into the wrong namespace is invisible to every gate
status: backlog
priority: medium
tags:
  - dogfood
  - i18n
type: feat
complexity: S
area: i18n
source: dogfood-inbox-aug
surface:
  - ops
  - plugins/i18n
audience: external
evidence: reported
created: '2026-08-08T12:01:23.975Z'
---
Adding a locale entry means editing a multi-thousand-key JSON BY TEXT POSITION: you find a plausible
sibling and insert next to it. That operation has a silent failure — sibling names repeat across
namespaces, so the entry can land under the wrong parent while the component reads the other one.
Nothing catches it: the typecheck cannot see it, and `t()` renders the raw key path only at runtime, on
that one screen.

`i18n_lookup` answers key→value and value→key, but not position→key. Wanted: `i18n_lookup {file, line}`
→ the dotted key path that line defines. One call after the edit turns the mistake into a diff instead
of a bug report. It is cheap: the locale files are already parsed for the other i18n ops, and the JSON
position→path mapping falls out of the same walk.

Probably the same walk, and the sharper form of the same answer: a key defined at one path and read at
another shows up in TWO separate reports — unused at its real path (`find_unused_i18n_keys`) and missing
at the read path (`find_missing_i18n_keys`) — that nothing cross-references. Pairing them ("defined at X,
read at Y, X≠Y — did you mean X?") names the actual defect instead of leaving it split across two
outputs.

## Свидетельство (2026-08-05, `amiro/forms-w3-refusal`)

`emailLocked` was inserted beside `emailInvalid`, which exists under BOTH `patients` and `team`, so the
key landed at `patients.emailLocked` while the component read `team.emailLocked`. Every gate stayed green
(typecheck, lint, tests, knip). It was caught by `i18n_lookup {key:'team.emailLocked'} → matched=0` — a
good answer to a question the reporter only thought to ask because the key was new. The same slip inside
an EXISTING namespace is undetectable until someone opens the screen.
