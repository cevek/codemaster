---
id: t-000009
title: '**the envelope `head` segment is no longer capped'
status: backlog
priority: low
type: bug
complexity: S
area: render
created: '2026-07-08T00:00:08.000Z'
---
**the envelope `head` segment is no longer capped — a pathological `failure.message` escapes
the 95KB-dump guard** — `src/format/render/render-result.ts` (the head-path of `renderResult`
/ `assembleEnvelope`). The envelope-seam fix reserves `head` (FAIL verdict + message) and
`tail` (honesty channels) against the budget so they always survive; only `bulk` is trimmed.
That is correct for the honesty channels, but it means a pathologically large `failure.message`
now renders unbounded — weakening the "never a 95KB dump" guarantee on the FAIL path. The
message is our OWN text (a `ToolFailure.message`, normally a short tool error), so this is a
latent edge, not a live leak. Fix: cap the FAIL message itself at the source, or give `head` a
generous own sub-budget before reserving it. `bug`·`low`·`cx:S`
