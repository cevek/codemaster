---
id: t-006194
title: affected (с since и без аргументов) не отвечает до таймаута MCP 300 с на worktree монорепо claude-ui
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
area: impact-usages
audience: external
evidence: reported
author: mb-ce356acc
created: '2026-11-16T09:41:53.283Z'
---
## Симптом
`affected {root:'<worktree claude-ui>', since:'55a18d816', testGlobs:['**/scripts/test-*.ts']}` → `MCP tool affected timed out after 300s`. Диф ~20 файлов, включая хаб (session.ts), импортируемый большинством ~450 сьютов. Без аргументов — тот же таймаут (2026-11-13). Нарушение §1 never-hang: `daemon.opDeadlineSeconds` = 120 с должен был вернуть `timeout`/`partial` раньше 300 с.

## Минимальный исход
Выяснить, какая часть не под дедлайном (холодный build программ worktree? обход импорт-графа?) и поставить её под `Deadline` → честный `partial` с тем, что успели. Тест на масштаб, не 3-файловая фикстура.

## Фрикшены
f-6rnmhlytt7fr, f-sfhtvz2w3u7p
Inbox: «affected times out (300s MCP watchdog) on a since-ref query against a worktree root» (2026-11-16T06:39).

Источник — журнал фрикшенов claude-ui и/или inbox `~/.codemaster/feedback/inbox.md`, ноябрь 2026. Репро на текущем main не снято (тег UNVERIFIED): первым шагом — воспроизвести.
