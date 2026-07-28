---
id: t-045024
title: 'The React RENDER tree is not the reference graph: no op answers "what providers are above this callsite" or "is this component reachable from a route (vs only from a story)" — two independent reports, both fell back to hand-reading'
status: backlog
priority: high
tags:
  - agent-surface
  - dogfood
type: feat
complexity: L
area: impact-usages
source: dogfood-jul
relates:
  - t-100043
  - t-159797
  - t-849286
surface:
  - ops
  - plugins/react
audience: external
evidence: reported
created: '2026-07-28T16:10:25.779Z'
---
Two independent external reports, two amiro worktrees, same underlying gap: every existing op answers
questions about STATIC REFERENCES, while the question being asked is about the RUNTIME RENDER TREE.

**Facet A — provider ancestry** (`save-only-page-forms-guard`). A hook changed behaviour depending on
whether its callsite renders inside a popup provider (`DirtyGuardProvider`, mounted by Dialog/Sheet) or on
a bare page. Sizing the blast radius needs: "of the 32 `useAppForm` callsites, which render under a
Dialog/Sheet subtree and which under `AppLayout`?" `find_usages` gives the enclosing function;
`importers_of` gives module edges. Both are static-reference facts. Fell back to grep + hand-reading each
file and the route files — and notes it is exactly the silently-incomplete mode the repo warns about,
since the discriminating fact for one callsite lived in a different file entirely.

**Facet B — reachability and callsite ROLE** (`save-only-patient-record-fixes`, needed twice in one
track). "Is this component reachable from the live UI?" `find_usages` honestly returns enclosers, but a
story file ranks equally with a production callsite, so "the only consumer is a story" has to be inferred
by eye from filenames (`PatientCarePlans` → only `PatientCarePlans.story.tsx`). The second instance is
worse: `ProfileEditPanel` is rendered under a switch on a string mode that nobody ever assigns — dead for
a DATA-FLOW reason that a reference query cannot see at all.

Asks, in the reporters' words:
- **callsite role in results** (prod / story / test), so "used only in a story" reads out of the answer
  instead of being eyeballed;
- **reachability from routes** — is there a render path from an entry point to this component;
- **provider ancestry** — which context providers enclose a given callsite.

Why this is one task and not three: all three need the same missing thing — a render-tree model built
from JSX composition plus route entry points, rather than the reference graph. Whether it ships as one op
or several is a design question for whoever picks it up; splitting the FINDINGS would hide that they share
a foundation.

Honesty constraints any implementation must carry, from the reports themselves: a mode-switch branch is
data-flow, not composition — it must be flagged `dynamic`, never silently resolved; and role
classification must come from configuration/convention that the repo declares, not from filename guessing,
or the tool merely automates the eyeballing it replaces.

Related: t-159797 (callback exit paths — the other "static references cannot answer this" family),
t-849286 (react-query consumption shape).
