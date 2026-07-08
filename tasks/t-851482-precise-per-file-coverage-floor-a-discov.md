---
id: t-851482
title: 'Precise per-file coverage floor: a discovered member covering SOME of its files but straying others still claims complete (narrow §3.4 residual)'
status: backlog
priority: medium
depends_on:
  - t-000073
type: bug
complexity: M
area: multi-program
source: dogfood-jul
created: '2026-07-08T10:11:41.388Z'
---
The 'precise (non-blunt) floor' STRETCH named in t-000073's body. Ask-1's coverage-proof (R) subtracts a discovered workspace member from the undiscovered set when its parsed config resolves >=1 file OR declares references — closing the BROAD lie (a zero-coverage/empty member is no longer falsely subtracted → floored). RESIDUAL (narrow): a member whose tsconfig covers SOME files but strays others (e.g. include:['src'] with an uncovered lib/foo.ts that no loaded program globs) is still subtracted → claims complete for the strayed files = a narrow §3.4 completeness lie. Only bites a partially-misconfigured member; normal members (all real target repos) fully covered. Close with member-DIRECTORY file-level coverage: walk each discovered member dir, require every source file be in the UNION of loaded programs else keep floored (a §19-bounded, cached walk). This is the precise-floor stretch, deferred from ask-1 by design.
