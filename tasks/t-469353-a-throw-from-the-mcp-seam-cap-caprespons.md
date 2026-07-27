---
id: t-469353
title: A throw from the MCP seam cap (capResponse) makes the call vanish from telemetry entirely — no record, no breadcrumb
status: backlog
priority: low
tags:
  - platform
type: bug
complexity: S
area: platform
source: dogfood-jul
created: '2026-07-27T23:12:37.770Z'
---
`src/mcp/call-telemetry.ts` clears the crash breadcrumb in a `finally` spanning the whole call, so a
throw from anywhere in the span (notably `capResponse`, whose call sits inside `run`) leaves neither
a usage record (the `record` line is never reached) nor a breadcrumb (the `finally` clears it). The
call disappears from telemetry completely.

The trade is deliberate and correct as far as it goes — leaving the breadcrumb would report the call
as a CRASH, which is a fabricated fatal for a process that is alive and answered the caller. But it
is a residual hole in "no call is invisible", independent of process death.

Fix direction: record an explicit failure entry in the span's `catch`/`finally` when the body threw
(`ok:false`, response naming the internal error), then clear the breadcrumb — an honest "the call
failed inside codemaster", distinct from both a success and a crash.
