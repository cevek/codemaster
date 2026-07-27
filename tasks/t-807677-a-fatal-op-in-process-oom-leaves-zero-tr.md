---
id: t-807677
title: 'A fatal op (in-process OOM) leaves ZERO trace: usage-log writes only after dispatch, so fail.jsonl silently under-reports the worst failures'
status: backlog
priority: high
parent: t-031282
tags:
  - dogfood
  - platform
type: bug
complexity: M
area: platform
source: dogfood-jul
created: '2026-07-27T22:21:44.741Z'
---
The `find_usages … force:true` call that OOM-killed the daemon on backoffice2 (see the sibling
force-escalation task) wrote NOTHING to `~/.codemaster/usage/fail.jsonl` — the last record there is the
earlier size-guard refusal (ts 1785190414084); the crash itself is absent from both fail.jsonl and
success.jsonl. `~/.codemaster/stalls/` holds only one unrelated file from Jul 17 (the watchdog catches a
SPIN, not an OOM — the process is gone before any thread can write).

So the telemetry (§13) systematically hides exactly the failures that matter most: a log reader
concludes the tool's worst outcome is a polite `bad_args`, when in fact it dies. Any triage driven off
fail.jsonl — including this session's — under-counts fatals to zero.

Fix: write a pre-dispatch breadcrumb and reconcile it, rather than logging only the completed call.
The watchdog beacon (`support/watchdog/`) already stamps `{op, bounded args, startTime}` in a SAB before
each heavy op — the same stamp should hit disk (an `inflight.jsonl` line, or a single overwritten
`inflight.json`), cleared on normal completion. On the next daemon start, a leftover inflight record is
promoted to a `fail.jsonl` entry with `tool:'crash'` + the recovered args, so the fatal is attributed to
the op that caused it instead of vanishing.

Done: an oracle-backed test that SIGKILLs the server mid-op and asserts the next start materializes a
fail record naming that op; the write path stays wrapped so a disk error never touches the request path.
