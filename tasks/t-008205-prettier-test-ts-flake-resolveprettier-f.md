---
id: t-008205
title: 'prettier.test.ts flake: resolvePrettier finds a prettier in a nested worktree (walks up past the mounted project root) — pre-existing on main'
status: backlog
priority: low
tags:
  - dogfood
  - test-infra
type: bug
complexity: S
area: platform
source: dogfood-jul
created: '2026-07-15T20:07:26.550Z'
---
**Repro (base 2f87af5, ANY track):** `node --test test/unit/prettier.test.ts` → subtest "resolvePrettier reports unavailable when the project ships no prettier (no bundled fallback)" FAILS (`Expected true !== false`). The test mounts a project with no prettier and expects `resolvePrettier` to report unavailable, but resolution walks UP the directory tree and finds the outer repo's `node_modules/prettier` when the worktree lives under a parent codemaster checkout (`/Users/cody/Dev/worktrees/codemaster/<wt>` nested under `/Users/cody/Dev/codemaster`).

Verified: fails identically on `2f87af5` (base) and on branch HEAD — NOT introduced by track G (importers_of hardening). The other 6 subtests pass; full suite is 1027/1029, this is the only non-passing (+ it's environmental).

**Open question:** is this a real robustness gap (resolvePrettier should stop at the project root, not walk into an ancestor repo) or a test-isolation artifact (the VFS project mount doesn't sever ancestor node_modules resolution)? If the former, it's a §-honesty concern: a repo shipping no prettier could get restyled against its intent by an ancestor's copy (contradicts §5-L1 "no bundled fallback"). If the latter, the test needs a hermetic root outside any ancestor node_modules.

Source: track G DoD full-suite run.
