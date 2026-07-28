---
id: t-034931
title: A daemon death is logged only as the bridge's `daemon connection closed` — a fatal that reads like a transport hiccup, with no crash discriminator
status: backlog
priority: medium
depends_on:
  - t-305430
tags:
  - dogfood
  - platform
type: bug
complexity: S
area: platform
source: dogfood-jul
relates:
  - t-137057
  - t-137128
  - t-460393
  - t-469353
  - t-954198
surface:
  - daemon
  - mcp
  - support
audience: internal
evidence: repro
created: '2026-07-27T23:16:30.698Z'
---
The bridge outlives its daemon, so when the daemon dies mid-call the bridge writes an ordinary record — `ok:false`, `isError:true`, a real `durationMs`, and a message saying the connection closed. A fatal that reads like a transport hiccup.

## What is already covered

The daemon now stamps its own in-flight breadcrumb around each dispatch (`begin`/`clear`, never `record`), so a daemon that died with a call running leaves a breadcrumb that a later start promotes as `outcome:'crash', origin:'daemon'`, naming the op it was actually running. That is the second half of this task's original fix direction, and it is done:

- triage filtering on `outcome:'crash'` DOES see a daemon fatal now;
- what the daemon was doing when it died is recorded, attributed to the op;
- a clean exit provably leaves no breadcrumb (`shutdown()` clears live ones, and a dispatch in flight holds the idle deadline open), so the presence of an `origin:'daemon'` record means a fatal rather than a normal idle-exit racing a request.

The bridge's own message no longer implies a cause it cannot establish: it carries a stable `daemon-link-closed` code, points at where the discriminator lives, and states outright that absence proves nothing — reconciliation only runs at a later codemaster start, so a real fatal reads as absent until then.

## What remains — and why the original framing does not survive

The first half of the original fix direction was: "classify the bridge's record as a crash-class outcome rather than a bare message." **That is not implementable as written.** The bridge survives; from its side a fatal and a clean exit are the same closed socket. The pidfile is a kill-target hint, never a liveness oracle (§3.5), so branching on it would assert a death that was not established — the fabricated-fatal lie `support/usage-log/inflight.ts` exists to prevent, and the exact inverse of the bug this task was filed for.

So the remaining work is not "make the bridge say crash". It is one of:

- **Correlate at read time.** The pair of records for one fatal is joinable on `cwd` + `ops` (not `tool` — that is derived on the daemon-side view). A triage consumer, or a small reader utility, can mark the bridge's record crash-class once the daemon's view is present. This keeps the assertion where the evidence is.
- **Or close the timing gap that makes absence ambiguous.** Reconciliation runs only at the next logger construction, so a reader looking immediately after a fatal sees neither record correlated. A promotion pass triggered on a bridge's closed-link failure — bounded, same claim-by-rename discipline — would make the discriminator available when the reader actually needs it.

Related: t-137128 (a usage-dir skew between the daemon and a later bridge breaks the correlation this rests on), t-954198 (`tool` is derived daemon-side, which is why the join keys on `ops`).
