---
id: t-000016
title: json op/batch consumers never see daemon self-staleness
status: backlog
priority: low
type: imp
complexity: M
area: platform
created: '2026-07-08T00:00:15.000Z'
---
**json op/batch consumers never see daemon self-staleness** — the always-on staleness banner
(`src/mcp/server.ts`) is a TEXT-mode prefix, suppressed in `format:'json'` (a prefix would
corrupt the single bare-JSON payload — §12). So an agent composing in json learns of daemon
source-drift only via `status` (`sourceStale: boolean`), never from the op/batch response it
acts on. Pre-existing; the honest json fix is a STRUCTURAL field on the envelope (e.g.
`ResultCommon.sourceStale?: true`, surfaced as a real key json keeps and text renders in the
tail) injected at the facade — deferred because it tugs a daemon-level fact into the L0
`core/result.ts` op-envelope and renders N× in a batch unless scoped to one result. `imp`·`cx:M`

## Поправка: названный здесь запасной путь недостижим

Текст выше опирается на то, что json-консюмер узнаёт о дрейфе «via `status` (`sourceStale: boolean`)». Этого пути нет: `statusToolSchema` (`src/mcp/schema.ts:36`) объявляет только `{root, brief, full, op}` — ни `format`, ни `verbosity`, ни `debug`; руками написанный `inputSchema` (там же:72) совпадает. То есть `status` вообще нельзя попросить в json, и структурированный `sourceStale` получить неоткуда.

Следствие: для json-консюмера дрейф демона сейчас не наблюдаем НИКАК — ни в ответе опа (баннер подавлен), ни через `status` (json-режима нет). Это усиливает задачу: структурное поле на конверте — не «более честный» вариант, а единственный.

Дешёвый промежуточный шаг, если структурное поле дорого: добавить `format` в `status`. Тогда описанный здесь путь хотя бы заработает так, как §11 его описывает (сейчас §11 в этой части расходится с кодом).

Связано: [[t-029489]], [[t-527994]] — соседние расхождения advertised-схем с каноническим zod-гейтом.
