---
id: t-000163
title: "FAIL envelopes repeat the `file it: feedback({kind:'bug'…})` footer"
status: backlog
priority: low
type: dx
importance: low
complexity: S
area: correctness
created: '2026-07-08T00:02:42.000Z'
---
**FAIL envelopes repeat the `file it: feedback({kind:'bug'…})` footer** — every `FAIL tool=…`
response appends the same feedback-CTA footer; in an agent loop hitting repeated FAILs it is
per-call noise. Consider emitting it once per session, or only on an internal-error FAIL (not a
conservative-refusal FAIL the agent expects). `dx`·`low`·`cx:S`
