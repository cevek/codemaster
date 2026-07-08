---
id: t-703317
title: "Member coverage floor is TS-source-only: an allowJs'd strayed .js/.jsx under a member is not floored (narrow under-floor)"
status: backlog
priority: low
type: bug
complexity: S
area: multi-program
source: dogfood-jul
created: '2026-07-08T11:40:47.610Z'
---
From t-851482 review (bug-reviewer should-fix, classified backlog-not-BLOCK). The per-file coverage floor's required-walk uses TS_SOURCE_RE (.ts|tsx|cts|mts) only, so a strayed .js/.jsx under an allowJs member is not counted → member not floored → a narrow under-floor. NOT introduced by t-851482 (pre-fix ignored extension entirely → subtracted unconditionally, same/worse). Including .js/.jsx blindly would floor on ordinary tooling JS (eslint.config.js etc.) no program owns = massive over-floor regression; distinguishing allowJs-source .js from tooling .js needs per-config allowJs inspection. fix-locus: src/plugins/ts/program/discover.ts (TS_SOURCE_RE + per-config allowJs).
