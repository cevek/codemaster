---
id: t-614260
title: Ops with an absolute `file`/`symbolId` inside a worktree FAIL "file not in the TS project" unless a redundant `root` is also passed — infer root from the absolute path
status: done
priority: medium
type: dx
complexity: S
area: platform
source: dogfood-jul
created: '2026-07-07T20:05:53.628Z'
---
**Absolute-path normalization bug (the reproduced defect).** An absolute `file`/`symbolId` path FAILed "file not in the TS project" — and it did so EVEN WITH a matching `--root` (the original "unless a redundant root is also passed" framing was wrong; triage + fix confirmed it fails with root too). Root cause: `absOf` in src/plugins/ts/ls-host.ts did `path.join(root, absPath)`, double-joining an already-absolute path into a nonexistent path.

Fixed at daf2ee4: the absolute branch funnels through `mintRepoRelPath` (§19 canonicalization — realpath + case-fold + symlink/pnpm over the canonical root) → brands to the SAME repo-rel key the relative form reaches; out-of-root abspath → mint refuses → honest "file not in the TS project". Relative addressing byte-identical. +3 differential tests (abs no-root / abs +root / case-variant identical; out-of-root honest fail). bug-reviewer: no blocking issues.

Root-INFERENCE from an absolute path when no root is passed (the original convenience ask) is split to **t-281434** (deferred — routing is arg-agnostic by design).
