---
id: t-691093
title: '`list`: pathInclude filters AFTER full enumeration (a narrow-looking arg is not a cheap query), and valid registry names are discoverable only by triggering an error'
status: backlog
priority: medium
tags:
  - agent-surface
  - dogfood
type: dx
complexity: M
area: render
source: dogfood-jul
created: '2026-07-27T23:00:25.827Z'
---
Two findings on `list`, from the OOM investigation (worker dd428a19, measured on backoffice2).

**1. `pathInclude` is a post-filter, not a scope narrower.** `list {registry:'components',
pathInclude:['apps/emr/src/containers/FormController']}` enumerates the WHOLE registry and filters
afterwards — measured to OOM a 1 GB engine child in ~10 s. This is the premise that made the original
daemon crash surprising: the call reads as "one folder", so neither the agent nor the reviewer expected
a repo-scale warm behind it. Either push the path filter down into the enumeration so a narrow arg is
actually cheap, or state plainly in the op's notes that `pathInclude` does not reduce cost.

**2. Valid registry names are discoverable only by error.** There is no way to ask `list` what it can
list; an agent guesses a name and reads the rejection. The available-list is already computed for that
rejection — surface it as a first-class answer (an empty/omitted `registry` returning the catalogue).

The rejection path itself is now correct and must stay: the semantic-fanout guard in `list` runs AFTER
the cheap owner resolve, so an unknown or non-ts-owned registry still gets its honest available-list
instead of a size-guard refusal (would have been a §3.6 regression).
