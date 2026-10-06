---
id: t-833715
title: extract_symbol шёл 460 с при op-лимите 120 с и kill изолированного движка на 150 с — найти, где время уходит мимо дедлайна
status: in-progress
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
created: '2026-10-06T13:16:52.831Z'
---
## Наблюдение
usage-лог (`~/.codemaster/usage/success.jsonl`, ts 1791272402468, 2026-10-06 07:40): `extract_symbol {name:leadClosedReasonLabelKey, file:src/features/people/people-domain.ts, dest:src/lib/lead-lexicon.ts}` в `/Users/cody/Dev/worktrees/amiro/pv2-kz-final` — `durationMs=460498`. Ответ: `FAIL tool=timeout … Cause: isolated engine did not reply in 150000ms — killed it.` Op deadline — 120 с (`daemon.opDeadlineSeconds`), kill изолированного движка — 150 с, а вызов длился 460 с. Там же рядом `transaction` n=2 — 150.9 с.

## Вопрос
Куда ушли ~310 с сверх kill: ожидание в очереди до начала (см. t-906818 — usage-лог время очереди не пишет?), респавн движка, сам kill/reply-путь, или `durationMs` меряет что-то иное. И почему работа внутри движка не уложилась в кооперативный дедлайн 120 с (что не отменяемо: сборка программы, reindex, наш синхронный код — §19).

## Минимальный исход
Сначала диагноз (методом, который можно перепроверить: лог/таймстемпы сессии агента `~/.claude-amiro*/projects/-Users-cody-Dev-worktrees-amiro-pv2-kz-final/*.jsonl`, `~/.codemaster/<repo>/debug.log`, child-stderr.log, stalls/), потом решение. Диагноз в таске — догадка.


## Диагноз (инвентаризация артефактов)
**460 с — это сон машины, а не работа и не очередь.** Цепочка (всё перепроверяемо):
- usage-лог: `ts` — СТАРТ вызова (`withCallTelemetry` в `mcp/call-telemetry.ts` пишет `ts: startMs`), `durationMs` — wall-clock `Date.now()`. Старт 12:40:02.468 (+0500), конец 12:47:42.966.
- сессия агента (`~/.claude-amiro/projects/-Users-cody-Dev-worktrees-amiro-pv2-kz-final/7186af2a-….jsonl`): tool_use 07:40:01.754Z, результат 07:47:42.677Z — «MCP server codemaster tool extract_symbol sent no response or progress for 460s; aborting». Харнесс оборвал вызов сам; наш ответ попал только в usage-лог (через ~0.3 с).
- `pmset -g log`: `12:40:12 Entering Sleep state (Maintenance Sleep)` → `12:47:42 Wake from Deep Idle … HID Activity`. `sysctl kern.sleeptime kern.waketime` (на момент расследования — последний цикл): sleep 12:40:13.889, wake 12:47:42.624 → 448.7 с сна. Из 460.5 с вызова движок бодрствовал ~11 с.
- libuv-таймеры на darwin считают сон: `process.hrtime` ≈ `os.uptime()` (4161117 vs 4161120 с при 48 днях аптайма со множеством снов). Поэтому 150-секундный kill-таймер `createProcessHost` (`requestDeadlineMs`) истёк ВО СНЕ и сработал в момент пробуждения — одновременно с idle-таймером харнесса. Ответ несёт текст `deadlineTripped` («did not reply in 150000ms — killed it»): kill произошёл, но ребёнок получил ~11 с CPU, не 150.
- Обслуживающий процесс — `node …/codemaster/src/bin.ts mcp --in-process` (конфиг `~/.claude-amiro/.claude.json`), движок авто-эскалирован в `process` (status: `isolation=process engines=1`). Внешнего bridge-дедлайна (150 с в `remote-orchestrator`) в этой топологии нет.

**Опровергнуто:**
- очередь: в usage-логе (все репо, все вызовы) в окне 12:32–12:47 других вызовов нет; t-255583 этим инцидентом не задет;
- респавн/startup: не нужен для объяснения — 460 = ~11 с бодрствования + 449 с сна;
- kill/reply-путь: ответ записан через ~0.3 с после пробуждения, сам путь мгновенный;
- «`durationMs` меряет иное»: меряет именно wall-clock от старта, включая сон — это и есть ловушка для читателя лога.

**Смежные факты (не этот инцидент):**
- `transaction` (extract+move, apply) 10:39:03→10:41:34 = 150.9 с и `find_usages personDisplayName` 11:16:16→11:18:34 = 136.8 с — машина бодрствовала (pmset чист). Это реальные экземпляры «работа не уложилась в кооперативные 120 с»; find_usages шёл сразу после kill'а transaction, т.е. включает холодный спавн дочки + прогрев, которые op-дедлайн не покрывает. Артефактов нет: `~/.codemaster/pv2-kz-final-*` не существует (debug.log не писался), stalls/ за 6 окт пуст. Установить причину можно только репро на копии с `CODEMASTER_DEBUG`.
- Класс «wall-clock дедлайн считает сон» (все через `Clock.schedule`/`Date.now`): `createProcessHost` request/startup/dispose/belt; `createRemoteOrchestrator` reply-deadline (после сна скажет «daemon busy/slow»); кооперативный `createDeadline` движка (op вернёт `timeout` на пробуждении); watchdog-воркер (`support/watchdog/worker.ts`, порог 5 мин по `Date.now`) — сон >5 мин с проставленным beacon даёт на пробуждении SIGKILL + stall-record `wedge`, которого не было. На Linux libuv берёт CLOCK_MONOTONIC (сон не считается) — класс darwin-специфичен.
