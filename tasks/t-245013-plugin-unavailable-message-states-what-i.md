---
id: t-245013
title: Plugin-unavailable message states WHAT is missing but never the ACTIVATION RULE — collapses "this repo has no i18n" with "you didn't configure i18n.locales", so an honest failure yields a false negative
status: backlog
priority: medium
tags:
  - agent-surface
  - dogfood
type: dx
complexity: S
area: render
source: dogfood-jul
created: '2026-07-28T08:27:19.424Z'
---
`find_missing_i18n_keys {}` → "DISPATCH unavailable: op needs plugin(s) [i18n] which are not active in
this workspace". Honest — it fakes nothing — but as a next-step signal it is a dead end, and it collapses
two states with opposite correct actions:

(a) the repo genuinely has no i18n surface → "this question does not apply here", stop;
(b) the plugin is gated on config that was never supplied (§10: i18n needs `locales`) and the repo DOES
    use `t()` → "supply `i18n.locales` and re-ask".

The cost is asymmetric: under (b) the agent silently concludes "no i18n facts available for this repo"
while the repo has them — a false negative reached through an honest-looking failure. That is §3.6
satisfied in letter (we said what we couldn't do) and missed in spirit (the agent cannot act on it).

Fix, one clause in the message: state the named plugin's ACTIVATION RULE alongside its absence —
"i18n activates on `i18n.locales` in codemaster.config (no autodetect)" vs "scss activates on a stylesheet
being present". That alone makes (a) and (b) distinguishable without reading ARCHITECTURE.

Observed on backoffice2, where it left the measured risk of the i18n ops recorded as "unknown, not low"
(t-004414) instead of an answer.
