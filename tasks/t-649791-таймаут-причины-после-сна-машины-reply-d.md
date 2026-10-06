---
id: t-649791
title: 'Таймаут-причины после сна машины: reply-deadline моста, кооперативный Deadline движка, startup-deadline процесс-хоста не говорят о сне'
status: backlog
priority: low
tags:
  - daemon
  - never-hang
type: imp
complexity: S
relates:
  - t-833715
evidence: reported
author: aecc37d1
created: '2026-10-06T13:28:51.144Z'
---
Тот же класс, что t-833715 (wall-clock дедлайн считает сон машины на darwin), там закрыт только request-таймаут `createProcessHost` + `suspendedMs` в usage-логе. Остальные потребители:
- кооперативный `createDeadline` (`common/async/deadline.ts`, движок `runOne`): op вернёт `timeout`/partial на пробуждении, хотя работы почти не было;
- startup-handshake `createProcessHost` (`startupDeadlineMs`): «engine child did not start in 60000ms».
Минимальный исход: те же формулировки сна из seam t-833715 в этих причинах.
