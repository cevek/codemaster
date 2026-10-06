---
id: t-469894
title: MCP-инструменты codemaster без tool-аннотаций (readOnlyHint) — клиент сериализует все вызовы, включая чтения
status: backlog
priority: medium
tags:
  - mcp
  - perf
type: perf
complexity: S
area: platform
evidence: measured
author: ba0cb7cf
created: '2026-10-06T13:29:12.699Z'
---
Списки инструментов в src/mcp (op-tools.ts, server.ts) не несут ни одной MCP tool-аннотации (readOnlyHint / destructiveHint / idempotentHint). Claude Code считает такие инструменты не-concurrency-safe и выполняет их строго по очереди.

Замер (сессия агента pv2-z-landing, 2026-10-06; ~/.codemaster/usage/success.jsonl): 4 transaction отправлены клиентом в 12:51:48/52/55/58; старт спана withCallTelemetry в мосту (startMs при входе хендлера) = 12:51:48.36 / 12:52:54.92 / 12:54:02.95 / 12:54:53.97 — каждый = концу предыдущего ±10 мс. 4-й ждал 233 с > BRIDGE_REPLY_DEADLINE_MS (150 с) и не упал → мост его не держал, ждал клиент.

Минимальный исход: немутирующие опы (OpDefinition.mutating !== true) объявляют readOnlyHint:true в tools/list; mutating — readOnlyHint:false (+destructiveHint где уместно). Выигрыш — параллельные чтения ПО РАЗНЫМ workspace (внутри одного движок всё равно сериализует, §8). Проверить на живом клиенте, что параллельные read-only вызовы реально уходят одновременно (тот же метод: ts в usage-логе vs таймстемпы tool_use).
