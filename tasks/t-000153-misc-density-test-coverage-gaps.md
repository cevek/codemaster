---
id: t-000153
title: misc density test-coverage gaps
status: backlog
priority: low
type: dx
complexity: S
area: full-density
created: '2026-07-08T00:02:32.000Z'
---
**misc density test-coverage gaps** — `dominant=sibling` prog-hoist case (symbol mostly in
`test/**`) has no dedicated test (only primary-dominant fixture); `find_usages text:true` 0-hit
note + truncated-text `… N more` hint untested; `expand_type` `constituents` `covered()`
substring-match has a theoretical false-positive (arm a substring of arm AB, head drops standalone
a without `...`) needing a TS-format bug to trigger. `dx`·`low`·`cx:S`
