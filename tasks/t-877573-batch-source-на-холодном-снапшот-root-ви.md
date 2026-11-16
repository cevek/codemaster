---
id: t-877573
title: batch / source на холодном снапшот-root висят минутами без ответа
status: backlog
priority: high
parent: t-982648
tags:
  - UNVERIFIED
  - dogfood
  - dogfood-nov
assigned_to_session: s-207994
type: bug
complexity: M
area: platform
audience: external
evidence: reported
author: mb-ce356acc
assignee: mi-f66810de
created: '2026-11-16T09:41:53.744Z'
---
## Симптом
- `batch` (root snapshot-6712ffb0-d5748e, 4× find_usages) — >2 мин без ответа.
- `source` (5 известных targets, root snapshot-c0783a99-a05807) — несколько минут running.
Снапшоты — свежие read-only копии без node_modules, root холодный. Даже холодный старт должен укладываться в дедлайн или отдавать `timeout` (§1).

## Минимальный исход
Воспроизвести на свежей копии claude-ui без node_modules, снять, где время (discovery/coverage walk, build программ, кросс-программный фан). Что не отменяется дедлайном — ограничить по дизайну.

## Фрикшены
f-6bgv4lsmp245, f-qvq7psl2qxp3

Источник — журнал фрикшенов claude-ui и/или inbox `~/.codemaster/feedback/inbox.md`, ноябрь 2026. Репро на текущем main не снято (тег UNVERIFIED): первым шагом — воспроизвести.
