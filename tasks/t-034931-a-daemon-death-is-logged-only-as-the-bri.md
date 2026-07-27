---
id: t-034931
title: A daemon death is logged only as the bridge's `daemon connection closed` — a fatal that reads like a transport hiccup, with no crash discriminator
status: backlog
priority: high
depends_on:
  - t-305430
tags:
  - dogfood
  - platform
type: bug
complexity: S
area: platform
source: dogfood-jul
created: '2026-07-27T23:16:30.698Z'
---
Measured in the default topology (bridge + daemon, `CODEMASTER_SOCK_DIR`/`CODEMASTER_USAGE_DIR`
pointed at temp dirs): with a `find_usages` in flight, SIGKILL of the daemon yields a bridge-side
record in `fail.jsonl`:

    tool=find_usages ops=[find_usages] ok=false isError=true durationMs=1417
    response="daemon connection closed"

So a daemon death IS visible — but only as the bridge's view of a closed socket:

- there is no crash discriminator, so triage filtering on `outcome:'crash'` (the field the in-flight
  breadcrumb work added) does not see it, and a reader scanning `response` cannot tell an OOM-killed
  daemon from a transient socket close or a normal daemon idle-exit racing a request;
- no in-flight breadcrumb is orphaned (the bridge survives and completes its own record normally),
  so the reconciliation path contributes nothing here;
- the args/cwd recorded are the bridge's, which is correct, but nothing records what the DAEMON was
  doing when it died (it keeps no usage log at all — see t-305430).

Fix direction (needs t-305430 decided first, since it settles who owns telemetry): when the bridge's
request fails because the connection dropped mid-call, classify the record as a crash-class outcome
rather than a bare message, and — if the daemon becomes the telemetry owner — let the daemon's own
in-flight breadcrumb attribute the fatal to the op it was actually running.
