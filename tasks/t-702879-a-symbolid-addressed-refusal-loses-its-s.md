---
id: t-702879
title: A symbolId-addressed refusal loses its subject, so the redirect degrades to a generic browse exactly where the agent held the most precise handle
status: backlog
priority: medium
tags:
  - agent-surface
  - dogfood
type: dx
complexity: S
area: render
source: dogfood-jul
created: '2026-07-28T12:36:28.366Z'
---
`ops/guard/navigate.ts` interpolates the refused call's subject into the redirect so the next call is
paste-able. It reads the subject from `name` / `query`. A call addressed by `symbolId` carries its
subject only inside the SymbolId payload, which is plugin-private by contract (ARCHITECTURE.md §6 —
everything past the routing prefix is opaque outside the owning plugin), so the guard layer cannot
read it without violating that opacity.

The observable effect on a large repo, measured on backoffice2 (6086 src files, auto-escalated to
process mode):

    op impact {"symbolId":"ts:Button@apps/emr/src/components/Button/Button.tsx:10:14~088897ca"}
    FAIL tool=oom — … impact cannot complete on this repo. NO cheaper in-tool path to this question
    (impact is what answers it); still runs here: symbols_overview {} → the repo's declared symbol
    names per tsconfig — pick one, then search_symbol on it.

The redirect is honest and runnable, but it is the SUBJECT-LESS one: it tells the agent to browse the
whole repo catalogue, when the agent had just handed us a fully-resolved handle naming `Button` and
its file. A bare-name call in the same situation gets `search_symbol {query:"Button",syntactic:true}`.
The precision inverts — the more exact the address, the vaguer the redirect.

Fixing it needs a design decision, which is why this is filed rather than built: the subject has to
come from the owning plugin, e.g. a `ts` plugin seam that maps a SymbolId to its `{name, file}`
without the caller parsing the payload. That seam must not warm the LS (the whole point is that the
heavy path is unavailable), so it is a syntactic/decode-only read, and it must fail honestly for a
handle the plugin cannot decode rather than guess a name.

Scope note: the guard path has the args only — the op that would know the resolved symbol either
never ran (the refusal precedes resolve, deliberately) or died with the isolated child (the
process-host OOM path). So the seam is the only place the subject can come from.
