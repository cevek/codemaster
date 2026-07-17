---
id: t-754922
title: Auto-escalate an oversized repo to process-mode isolation transparently (no manual config) — DEFERRED until the live process-mode E2E passes + opt-in mileage
status: backlog
priority: low
parent: t-031282
tags:
  - multi-program
  - platform
type: feat
complexity: L
area: platform
created: '2026-07-17T01:14:53.910Z'
---
Option 2 from the t-167395 backstop decision — the TRANSPARENT fix (vs the honest-refusal guard, which is the now-fix in the sibling high task). Instead of refusing a heavy fan-out op on an oversized in-process repo, DETECT the big repo at spawn (same cheap file-count as the size-guard) and raise THAT engine into process-mode even under the `in-process` default — so the op SUCCEEDS in an isolated, memory-bounded, killable child, transparently, with no manual config.

## Why DEFERRED, not now
Auto-escalation makes the op succeed by auto-routing the BIGGEST repos onto the NEWEST, least-proven code path — process-mode, whose full live `mcp → socket → serve-engine` path is not yet integration-tested (t-000052's own "не покрыто в изоляции"). Auto-mounting prod's hardest cases onto an un-proven path without explicit opt-in is exactly the bet §1 says not to make. It must EARN its way in.

## Preconditions (gate before picking this up)
1. The live process-mode integration E2E (`mcp` bridge → daemon socket → `serve-engine` child under a real MCP client) passes — the manager's post-keystone E2E.
2. Process-mode has accrued opt-in mileage (users running `isolation:'process'` without incident).

Until then the honest-refusal guard (sibling high task) holds the §1 line under the default config. This task is the transparency upgrade on top.
