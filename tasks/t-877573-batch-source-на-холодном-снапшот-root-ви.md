---
id: t-877573
title: batch / source на холодном снапшот-root висят минутами без ответа
status: backlog
priority: high
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


## Разбор
Локально не воспроизведён: на клоне claude-ui с node_modules batch 4× find_usages идёт 9 с, на archive-копии без node_modules — 4 с. Посылка «снапшоты без node_modules» неверна: claude-ui `createSnapshot` зеркалит node_modules родителя.

Гипотеза под проверкой: побочный эффект синхронного многоминутного вызова на ДРУГОМ root в общем in-process демоне на mac. Класс t-006194: `affected` 249 с синхронно держит event loop. Обе записи (21:07/21:08 UTC 15.11) — разные снапшот-root, минута между ними. Логи mac запрошены. Кода в треке t-006194 под эту таску нет; исход — по логам.


- Отдельный холодный `source` с 5 целями на клоне с node_modules — 8.6 с.
- Оговорка: `mirrorNodeModules` в claude-ui глотает ошибку (`.catch(console.warn)`), так что снапшот без node_modules возможен при сбое зеркала. Значит, форма исходных mac-снапшотов не доказана. На обеих формах (с node_modules и без) локально не висит.


## Данные mac (usage-лог + stalls, собраны агентом на mac)
- **Топология mac — не общий демон.** У каждого агента свой `node …/codemaster/src/bin.ts mcp --in-process` (6 процессов; status: `isolation=in-process engines=1`); конфигов с `opDeadlineSeconds`/`isolation` нет. Гипотеза «чужой синхронный вызов держал общий event loop» **опровергнута**.
- **Записи симптомов.** Оба вызова ЗАВЕРШИЛИСЬ, в пределах дедлайна 120 с:
  - 2026-11-15T21:06:46Z `source` (5 targets, snapshot-c0783a99) — 115 002 мс, ok;
  - 21:07:03Z `batch` (4× find_usages, snapshot-6712ffb0) — 102 998 мс, fail по элементу;
  - там же: 21:00:34Z `find_usages {symbols:[5]}` (snapshot-edee43e5) — 78 757 мс;
  - 21:15:28Z `batch` (snapshot-75ab6c1b) — 26 198 мс.
- **Нагрузка окна** 20:50–21:30: 165 вызовов за 40 мин по свежим снапшот-root, сумма 770 с.
- **Вывод.** Это не зависание, а медленный холодный первый вызов на свежем снапшоте: ~80–115 с на mac против 4–9 с здесь на той же форме. Причина 10-кратной разницы не установлена.
- **Кандидаты для следующего замера:** конкуренция нескольких in-process процессов, строящих программы одновременно; стоимость fs-проб (stat/realpath) на APFS-клоне node_modules.
- **Нужно:** CPU-профиль (`--cpu-prof`) холодного `source` на свежем снапшоте НА mac, один раз в покое и один раз под нагрузкой.
- **Попутно.** Два `affected` на mac (13.11 ub1-wake-and-revive, 16.11 primer-assembler) убиты watchdog'ом на 305 с (stalls `reason:wedge`, `op:affected`). Это класс t-006194, он исправлен там.
