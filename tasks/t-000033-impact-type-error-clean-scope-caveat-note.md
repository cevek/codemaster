---
id: t-000033
title: "impact_type_error: clean-scope caveat note"
status: backlog
priority: low
type: bug
importance: low
complexity: S
area: phase-5
created: '2026-07-08T00:00:32.000Z'
---
**impact_type_error: clean-scope caveat note** — `clean:true` means "no introduced error WITHIN the
reference-closure scope"; a purely-structural breaker that never references the symbol by name (outside
the find_usages closure) is missed. Matches impact's reference-closure contract, but a standing
one-line scope-note on the clean verdict would stop `clean` being read wider than it is. `bug`·`low`·`cx:S`
