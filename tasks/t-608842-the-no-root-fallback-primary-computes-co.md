---
id: t-608842
title: The no-root fallback-primary computes 'coverage' under WRONG options — the recurring root behind the multi-program honesty patches; stop counting fallback-globbed files as coverage (or synthesize a correct-options aggregate for a no-root repo)
status: backlog
priority: medium
type: imp
complexity: L
area: multi-program
source: dogfood-jul
created: '2026-07-08T13:42:48.569Z'
---
Architectural forward-flag (advisor, Wave 6). t-816306, t-851482, t-665557, t-232769 all layer around the SAME root: when a repo has no root tsconfig, the primary is the '(no tsconfig)' FALLBACK, which globs files under DEFAULT options (no paths/baseUrl). Its file-set is counted as 'coverage', but a file covered only by the fallback has its alias imports UNRESOLVED there → treating it as covered enables a complete=true-while-aliases-unsearched lie. Each patch works AROUND this (member-program injection, correct-resolution unions, coverage-⊆ gates). The real fix: stop treating fallback-globbed files as coverage at all, OR synthesize a correct-options aggregate program for a no-root monorepo (union the members' options / a virtual root). If a 5th multi-program honesty patch appears against the fallback, do THIS instead of routing around it. Not urgent, but the pattern is now visible and worth fixing at the root. fix-locus: src/plugins/ts/program (fallback primary + coverage union), ls-host.ts.
