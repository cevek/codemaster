---
id: t-872370
title: find_usages text:true overlay is name-based and not prop-filtered — disclosed in prose only, the rows still inflate the set
status: backlog
priority: low
tags:
  - agent-surface
  - dogfood
type: imp
complexity: S
area: impact-usages
source: dogfood-jul
relates:
  - t-312942
  - t-709349
surface:
  - ops
  - plugins/ts
audience: both
evidence: reported
created: '2026-07-28T16:23:07.480Z'
---
`find_usages {props:{…}, text:true}` runs the textual overlay off the symbol NAME (a scanner, not
the LS), so its section lists occurrences that never passed the `props` filter. The op discloses
this per call (`PROPS_TEXT_NOTE`), which keeps it honest, but the headline row set is still larger
than the filtered question.

Options: refuse the combination (like the non-jsx `role` conflict), or keep the section and label
the rows so a reader cannot mistake them for filtered matches.
