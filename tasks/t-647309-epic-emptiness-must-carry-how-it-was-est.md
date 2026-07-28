---
id: t-647309
title: 'EPIC: emptiness must carry HOW it was established — five measured instances where a true answer reads as proven absence'
status: backlog
priority: urgent
tags:
  - dogfood
  - epic
  - honesty
type: imp
complexity: L
area: correctness
source: dogfood-jul
created: '2026-07-28T20:34:26.581Z'
---
Five instances found in one session, five DIFFERENT mechanisms, one symptom: the tool returns `0` /
`found:0` / a small count, the number is TRUE, and the reader concludes something the tool never
established. This is not silent truncation (§3.4 — the count is right and often the floor IS disclosed);
it is a **scope mismatch**: the question maps onto a different set than the one measured, and nothing in
the answer says the two diverged.

Close this as an INVARIANT, not as five fixes. Whoever takes one of these alone will patch a symptom and
leave the class intact — that is how it reached five.

Members, each with a live repro in its own body:
- **t-162650** (urgent) — `construction_sites` renders a semantic verdict over a program it never scanned
  (`files=0`), and its remedy blames the caller's scoping. TWO independent repos; second instance DID scan
  (`literals=7 files=4`) and still missed a call-argument literal with conditional spread.
- **t-100043** — `member_usages` returns `sites=1` where 6 consumers exist: the type edge is severed at the
  `ops→JsonValue` seam, so the checker has nothing to link. `impact_type_error` cannot help either.
- **t-585566** — `find_unused_props` launders a failed component lookup into `ok{found:0}`, and its own
  test pins that shape as the contract.
- **t-194771** — `trace_prop_through_tree` asserts proven-absence over a CAPPED member set, while
  `find_unused_props` over the same `firstParamTypeMembers` correctly answers `undetermined`. One seam, two
  consumers, two different honesty levels.
- **t-288409** — config-key identity (env var names) is reachable by no op, so "is `OPENAI_BASE_URL`
  referenced anywhere?" is answered only as well as the agent guessed spellings. An absence nothing
  establishes.

## The invariant to build

An empty or small result must carry WHAT WAS ACTUALLY SEARCHED: which programs were scanned (and which
were not), whether the candidate set was capped upstream of the filter, whether the edge the question
needs exists at all in the type graph. `0` then means "searched here, found nothing" rather than "nothing
exists".

Precedent already in the tree, and it is why this is tractable: `find_usages` fans across programs, tags
rows with their program, and carries `complete:false` + `!! LOWER BOUND`. The machinery exists; the other
ops neither fan nor disclose. Also see the envelope disclosure work (t-876408) — the pattern of stating a
claim ONCE at the point where it is established, so every consumer inherits it rather than remembering to.

## Cheapest way to find the rest

From worker cb8fedab, having found the third instance in a neighbouring op while fixing its own:

> when you fix honesty in one consumer of a seam, look at the others

`find_unused_props` and `trace_prop_through_tree` read the SAME capped seam and answered differently. That
divergence is visible only to someone already holding the defect's shape — so audit by SEAM, not by op.
