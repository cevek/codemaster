---
id: t-021513
title: Rename in a loose-root member reports false 'forward' captures — the capture gate is primary-only while the primary cannot resolve the member's paths
status: backlog
priority: high
tags:
  - dogfood
type: bug
complexity: M
area: ts-refactor
source: dogfood-jul
relates:
  - t-000524
surface:
  - plugins/ts
audience: internal
evidence: measured
created: '2026-07-30T12:08:51.688Z'
---
In a loose-root monorepo (root globs `apps/**`, the `@/…` `paths` live only in the member config) a
plain `rename_symbol` on a member symbol emits FALSE `forward` captures — "rewritten reference now
binds to a different in-scope binding" — for legitimate reference sites.

Measured on two VFS fixtures (barrel-based and direct-import), identically under BOTH bare-`{name}`
and `file:line:col` addressing — so it is independent of how the target is addressed, and predates
the t-000524 alias collapse.

Cause: `plugins/ts/refactor/rename/rename-sites.ts` filters the capture gate's input by primary
RESIDENCY, but in a loose-root repo a primary-resident file is still primary-UNRESOLVABLE (`@/…`
does not resolve there). The post-edit reference set computed from the declaration therefore does not
contain those sites, and each is marked `forward`.

This is the over-refusal §7 names as risk #1: a false capture on a legitimate refactor blocks a
correct edit, and an agent that sees it once stops trusting the gate. The remedy has to make the
capture gate resolve the member's imports the way the read path now does (a program whose config
declares the paths), not to loosen the gate.

Not introduced by t-000524, but that fix widens REACHABILITY: bare-name renames in barrel-heavy
loose-root repos now resolve instead of failing ambiguous, so they reach this gate where they
previously stopped earlier.
