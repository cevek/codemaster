---
id: t-104630
title: source с несколькими targets при verbosity:full печатает тела только первых двух — остальные 'elided, re-request individually'
status: backlog
priority: low
tags:
  - UNVERIFIED
  - dogfood
  - dogfood-nov
type: dx
complexity: S
area: render
audience: external
evidence: reported
author: mb-ce356acc
created: '2026-11-16T09:41:52.828Z'
---
## Симптом
`source` с 5 targets (`makeReviewTool, makeAskTool, runWork, MESH_BACKGROUNDABLE, ONE_SHOT`): первые два тела целиком, остальные — заголовки + `… source elided for 3 target(s) (re-request individually)`. Маркер честный, но бюджет на тела явно ниже потолка ответа (60 KB) — агент тратит N доп. вызовов.

## Минимальный исход
Измерить: какой cap режет (per-op char cap vs явный лимит тел) и сколько байт реально было. Если бюджет режет раньше MCP-потолка без нужды — распределять его по targets, а не отдавать первым двум.

## Фрикшены
f-ma4xc5zh2rxb, f-wlkh34o4dcn6, f-3b2umnveyntk

Источник — журнал фрикшенов claude-ui и/или inbox `~/.codemaster/feedback/inbox.md`, ноябрь 2026. Репро на текущем main не снято (тег UNVERIFIED): первым шагом — воспроизвести.
