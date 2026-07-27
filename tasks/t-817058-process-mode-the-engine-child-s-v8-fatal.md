---
id: t-817058
title: "process-mode: the engine child's V8 fatal-OOM dump (~110 lines) floods the parent's stderr before the honest FAIL — fork stdio is 'inherit'"
status: backlog
priority: low
parent: t-031282
tags:
  - dogfood
  - platform
type: dx
complexity: S
area: platform
source: dogfood-jul
created: '2026-07-27T22:33:08.008Z'
---
Observed while verifying the child-OOM path on backoffice2 (isolation:'process', maxOldSpaceMB:1024).

`fork-engine.ts:42` forks the engine child with stdio `'inherit'`, so when the child dies of OOM its V8
fatal-error dump (~110 lines of stack) lands on the PARENT's stderr, immediately before the honest
`FAIL tool=oom` reaches the client.

Harmless over MCP (stdout — the agent-facing payload — is untouched, §13), but on the CLI path the user
sees ~110 lines of noise ahead of the one line that matters. Route the child's stderr through the debug
sink (§13) instead of inheriting it, so the dump is greppable in the per-repo log rather than sprayed at
the terminal. Keep it capped — a fatal dump is bounded, but the sink is the right owner.
