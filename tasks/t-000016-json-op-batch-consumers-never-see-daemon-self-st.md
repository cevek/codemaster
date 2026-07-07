---
id: t-000016
title: json op/batch consumers never see daemon self-staleness
status: backlog
priority: low
type: imp
complexity: M
area: bug-sweep
created: '2026-07-08T00:00:15.000Z'
---
**json op/batch consumers never see daemon self-staleness** — the always-on staleness banner
(`src/mcp/server.ts`) is a TEXT-mode prefix, suppressed in `format:'json'` (a prefix would
corrupt the single bare-JSON payload — §12). So an agent composing in json learns of daemon
source-drift only via `status` (`sourceStale: boolean`), never from the op/batch response it
acts on. Pre-existing; the honest json fix is a STRUCTURAL field on the envelope (e.g.
`ResultCommon.sourceStale?: true`, surfaced as a real key json keeps and text renders in the
tail) injected at the facade — deferred because it tugs a daemon-level fact into the L0
`core/result.ts` op-envelope and renders N× in a batch unless scoped to one result. `imp`·`cx:M`
