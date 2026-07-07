---
id: t-815425
title: 'Markdown/doc plugin: §-cross-ref + relative-link resolution, heading outline (`list registry:sections`), doc↔code drift anchors; + `status` should report TS source-file count'
status: backlog
priority: low
tags:
  - dogfood-jul
type: feat
importance: low
complexity: L
area: wish
created: '2026-07-07T20:07:21.815Z'
---
Inbox entries 16, 17, 18, 19, 139, 144, 146, 151 (`task-manager`, docs-heavy/greenfield sessions), 2026-07-03. Architecture-doc reviews fit codemaster's proof-carrying model but have zero applicable ops today (all ops are TS/React-symbol-shaped), so the whole session runs on Read + manual cross-referencing.

Wishes: (1) a markdown/doc plugin — resolve intra-doc `§N` cross-refs and relative links (ARCHITECTURE.md has ~30), a heading outline / `list {registry:'sections'}`, and later doc↔code drift anchors ("does the symbol/file a doc names still exist" — a natural join with the `ts` plugin). Would also serve the `doc-sync-reviewer` flow. (2) Greenfield/docs-only discoverability: `list` on a zero-source repo returns `found=false` which can't distinguish unknown-registry vs empty-project vs no-TS-source; and `status` doesn't state "0 TS source files". A one-line `sources: N files` in the status header + a "no TS sources under root" hint on `list`/plugin-not-active would settle it up front.
