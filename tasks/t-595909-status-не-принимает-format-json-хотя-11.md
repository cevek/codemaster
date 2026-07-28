---
id: t-595909
title: status не принимает format:'json', хотя §11 указывает на него как на путь к sourceStale; batch.requests теряет min(1)
status: backlog
priority: low
tags:
  - docs
  - mcp
  - schema
type: bug
complexity: S
area: docs
source: dogfood-jul
created: '2026-07-28T15:16:44.113Z'
---
Схемы `status` и `batch` написаны руками в `src/mcp/schema.ts` — в отличие от per-op тулов, генерируемых из того же zod, что и валидирует, — и разъехались с ним.

**1. `status` + `format:'json'` недостижим.** ARCHITECTURE §11 про self-staleness баннер: «suppressed in `format:'json'` (a prefix would corrupt the single bare-JSON payload — json consumers read the structured `sourceStale` from `status`)». Но `statusToolSchema` (`src/mcp/schema.ts:36`) объявляет только `{root, brief, full, op}`, и advertised `inputSchema` (там же:72) тоже. Указанный докой путь для json-консюмера недостижим: структурированный `sourceStale` из `status` получить нельзя, потому что `status` нельзя попросить в json.

Развилка: править доку либо добавить `format` в `status`. Второе выглядит правильнее — `status` это first-contact манифест, машинно-читаемый режим ему по профилю положен наравне с остальными опами.

**2. `batch.requests` теряет `minItems`.** zod — `z.array(opRequestSchema).min(1)`; руками написанный `inputSchema` (`src/mcp/schema.ts:99`) — без `minItems`. Пустой `requests` проходит харнесный гейт и падает на zod.

Класс проблемы общий: у ручных схем `status`/`batch` нет анти-дрейф-теста против собственных zod-двойников, тогда как per-op схемы расходиться не могут по построению.

Готово, когда: расхождение №1 закрыто в одну сторону (код или дока), и есть тест, сверяющий обе ручные схемы с их zod-двойниками — либо они генерируются тем же `z.toJSONSchema`.
