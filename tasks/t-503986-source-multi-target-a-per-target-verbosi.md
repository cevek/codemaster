---
id: t-503986
title: 'source multi-target: a per-target verbosity override (or auto-degrade an oversized body to terse + line-range) instead of fully eliding it — avoid the forced second round-trip'
status: backlog
priority: low
tags:
  - dogfood
type: dx
complexity: S
area: render
source: dogfood-jul
created: '2026-07-15T11:33:22.840Z'
---
`source` with 5 targets at verbosity:full returned 4 bodies; the largest was replaced with "… source elided for 1 target(s) (re-request individually)". Reasonable size protection, but: (1) no indication of WHICH size threshold tripped or how close the others were, and (2) it forces a second round-trip a per-target knob could avoid.

**Ask.** A per-target verbosity override (full for these 4, terse for that one; or cap each body at N lines), OR auto-degrade the oversized target to terse + a line range instead of fully eliding it — removing the extra call. Everything else about source was frictionless.

Inbox source: 2026-07-10 (line 192).
