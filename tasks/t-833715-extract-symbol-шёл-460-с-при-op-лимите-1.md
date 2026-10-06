---
id: t-833715
title: extract_symbol шёл 460 с при op-лимите 120 с и kill изолированного движка на 150 с — найти, где время уходит мимо дедлайна
status: backlog
priority: high
parent: t-906818
tags:
  - daemon
  - mutation
  - never-hang
type: bug
complexity: M
evidence: measured
author: fad2132f
assignee: aecc37d1
created: '2026-10-06T13:16:52.831Z'
---
## Наблюдение
usage-лог (`~/.codemaster/usage/success.jsonl`, ts 1791272402468, 2026-10-06 07:40): `extract_symbol {name:leadClosedReasonLabelKey, file:src/features/people/people-domain.ts, dest:src/lib/lead-lexicon.ts}` в `/Users/cody/Dev/worktrees/amiro/pv2-kz-final` — `durationMs=460498`. Ответ: `FAIL tool=timeout … Cause: isolated engine did not reply in 150000ms — killed it.` Op deadline — 120 с (`daemon.opDeadlineSeconds`), kill изолированного движка — 150 с, а вызов длился 460 с. Там же рядом `transaction` n=2 — 150.9 с.

## Вопрос
Куда ушли ~310 с сверх kill: ожидание в очереди до начала (см. t-906818 — usage-лог время очереди не пишет?), респавн движка, сам kill/reply-путь, или `durationMs` меряет что-то иное. И почему работа внутри движка не уложилась в кооперативный дедлайн 120 с (что не отменяемо: сборка программы, reindex, наш синхронный код — §19).

## Минимальный исход
Сначала диагноз (методом, который можно перепроверить: лог/таймстемпы сессии агента `~/.claude-amiro*/projects/-Users-cody-Dev-worktrees-amiro-pv2-kz-final/*.jsonl`, `~/.codemaster/<repo>/debug.log`, child-stderr.log, stalls/), потом решение. Диагноз в таске — догадка.
