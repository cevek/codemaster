---
id: t-607895
title: watchdog-воркер после сна машины >5 мин SIGKILL'ит живой процесс и пишет ложный stall-record wedge
status: backlog
priority: medium
tags:
  - never-hang
  - watchdog
type: bug
complexity: S
relates:
  - t-833715
evidence: reported
author: aecc37d1
created: '2026-10-06T13:28:47.866Z'
---
## Механизм (по коду, не воспроизведён)
`support/watchdog/worker.ts` `tick` сравнивает `Date.now()` со `startMs` beacon'а против порога `DEFAULT_THRESHOLD_MS` (5 мин, `support/watchdog/install.ts`). Date.now и libuv-таймеры на darwin считают сон машины (t-833715: hrtime≈os.uptime). Сон >5 мин, пока beacon проставлен (идёт op), → на пробуждении первый tick видит elapsed >порога → `reap('wedge')`: stall-record о зависании, которого не было, и SIGKILL процесса, который просто спал. Под `mcp --in-process` это убивает обслуживающий сервер агента. В инциденте t-833715 (сон 449 с < 5 мин) не сработало.

## Минимальный исход
Перед reap сверить окно beacon'а со сном (seam последнего цикла sleep/wake из t-833715) и вычесть сон из elapsed; сон в окне без перевышения порога по бодрствованию — не wedge.
