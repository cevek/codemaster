---
id: t-537226
title: Замер ожидания в очереди движка (engine.enqueue) — время ожидания отдельно от времени работы в ответе и usage-логе
status: backlog
priority: low
tags:
  - daemon
  - telemetry
type: dx
complexity: M
area: platform
evidence: reported
author: ba0cb7cf
created: '2026-10-06T13:29:21.778Z'
---
WorkspaceEngine.enqueue (src/daemon/engine.ts) сериализует запросы одного workspace (§8). Когда несколько клиентов (разные агенты/сессии) бьют в один workspace, запрос ждёт молча; usage-лог (mcp/call-telemetry.ts) пишет durationMs = ожидание + работа без разделения, ответ ожидание не называет.

Инцидент t-906818 (3 мин ожидания) этим НЕ объясняется — там очередь была у клиента (таска про readOnlyHint); этот путь вживую не наблюдался, отсюда evidence=reported.

Исход: момент постановки в очередь и момент старта работы проходят до ответа (через process-host для изолированного движка); usage-запись несёт waitMs; ответ, ждавший дольше порога, несёт строку «ждал N с за другими запросами к этому workspace». Пересекается по файлам с t-833715 (process-host/engine) — брать после него.
