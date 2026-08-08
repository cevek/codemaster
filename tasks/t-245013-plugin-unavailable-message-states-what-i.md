---
id: t-245013
title: Plugin-unavailable message states WHAT is missing but never the ACTIVATION RULE — collapses "this repo has no i18n" with "you didn't configure i18n.locales", so an honest failure yields a false negative
status: backlog
priority: high
parent: t-826059
tags:
  - agent-surface
  - dogfood
type: dx
complexity: S
area: render
source: dogfood-jul
relates:
  - t-004414
  - t-286255
  - t-457761
  - t-762238
  - t-847874
  - t-891340
surface:
  - daemon
  - ops
audience: external
evidence: repro
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

## Свидетельство — second independent report, a different plugin, same dead end (dogfood-inbox-aug)

2026-08-05, repo amiro-frontend, external agent. `list_endpoints` → «needs plugin(s) [schema] which are not
active in this workspace», in a repo whose generated client (`src/api/generated/api.ts`,
`local-handlers.ts`) IS in the tree and machine-readable. Reporter: «сообщение … не говорит, ЧЕМ плагин
активируется (нет OpenAPI-файла? не сконфигурирован в `codemaster.config.ts`?) — то есть отказ есть, а
действия за ним нет.» The agent then wrote a one-off node script for the question.

This is state (b) from the analysis above, on `schema` rather than `i18n`, reached by an agent who cannot edit
that repo's config — the asymmetric-cost case. Priority raised medium→high: two independent reports, two
plugins, external audience both times, and each ended in hand-rolled tooling rather than a decision.

Sibling forms: t-891340 (the unsupported-workspace gate has the same defect at first contact — it names a
config lever whose effect the reader cannot certify) and t-762238 (the capability this particular refusal was
blocking).
