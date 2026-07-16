---
id: t-368812
title: "walk.ts symlink-cycle busy-loop: don't-follow symlink dirs + depth/entry cap; AND cache the per-op freshness walk (§1 never-hang root fix)"
status: backlog
priority: urgent
parent: t-895142
tags:
  - platform
type: bug
complexity: M
area: platform
created: '2026-07-16T11:06:21.114Z'
---
**Root cause (verified — see parent t-895142).** `src/support/fs/walk.ts` `visit()` uses `statSync` (follows symlinks) and recurses into any "directory" with NO realpath/visited guard and NO depth bound. K≥2 ancestor symlinks → virtual paths grow ~K^32 → eternal 100% CPU sync spin (event loop dead → SIGTERM/stdin-EOF/parent-death all unserviceable). Reached because on a NON-GIT root the freshness guard runs `checkWalk → walkFiles(root)` on **every op request** (`src/daemon/freshness.ts:183`), plus engine-spawn discovery. First `tools/call` from `cwd=/tmp` wedges.

**Fix — two parts, BOTH in this track (advisor):**
1. **Bound the walk (`support/fs/walk.ts`).** `lstatSync` and DO NOT descend into symlinked directories (NOT realpath+visited-set — speculative complexity for a case the walk never needs: git roots use `git ls-files`, pnpm symlinks live in ignored `node_modules`, module resolution handles realpath separately). Add a depth bound + a hard entry-count cap with an honest `partial`. A skipped legit-symlinked source dir must be **NON-SILENT** — count/surface skipped symlink dirs (§3.4), never a silent drop. (If following-into-symlinked-source is ever really needed, add opt-in realpath+visited-set THEN.)
2. **Cache the per-op freshness walk (`daemon/freshness.ts`) — the under-scoped part.** `checkWalk → walkFiles(root)` per op-request is ITSELF a §1 "per-call work that scales with repo size" violation, independent of the cycle — even a bounded acyclic walk re-run every call is wrong. Fingerprint once, reuse across calls (cache/debounce), with a deadline → `ToolFailure{timeout}` on overrun (honest "couldn't verify freshness — fall back", never silently-stale, never spin).

**Discriminating tests (gate):** (a) K≥2 symlink-cyclic dir terminates BOUNDED with `partial` (not hang); (b) huge acyclic tree → `ToolFailure{timeout}`, not hang; (c) per-call freshness re-walk is cached — walk runs ONCE across N op calls (assert via counter/spy); (d) git-root path byte-UNCHANGED (uses `ls-files`, not `walkFiles`). Verify no existing test relies on the walk traversing a symlink; normal discovery still finds real files. Minimal repro is in parent t-895142.

Ships ahead of further dogfood waves — live §1 violation recurring for any agent running codemaster from /tmp or a symlink-heavy non-git dir.
