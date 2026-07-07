---
id: t-000050
title: "MCP connection instability over long sessions (UNVERIFIED — likely harness-side)"
status: backlog
priority: low
type: bug
importance: low
complexity: M
area: platform
created: '2026-07-08T00:00:49.000Z'
---
**MCP connection instability over long sessions (UNVERIFIED — likely harness-side)** — dogfood
friction (amiro, 2026-06-28): during a long multi-agent session the codemaster MCP cycled
disconnect→reconnect several times, so the agent stopped trusting op calls and fell back to
grep/Read. **Not reproduced as a codemaster bug**, and the strong tell that it is client/harness-side
is that codegraph/playwright/chrome-devtools cycled in the SAME reminders — codemaster cannot fix a
client cycling every server. The codemaster-actionable mitigation (a reconnect "warm and ready"
signal) is tracked separately under Wishes. Keep here only as a watch-item; promote to a real bug
iff a repro pins the disconnect to the daemon (idle-evict racing a live bridge / socket teardown).
`bug`·`low`·`cx:M`
