---
id: t-568278
title: 'batch: requests[].args — голый object, name — свободная строка: внутри батча теряется типобезопасность per-op схем'
status: backlog
priority: medium
tags:
  - mcp
  - schema
type: dx
complexity: M
area: platform
source: dogfood-jul
created: '2026-07-28T15:18:48.435Z'
---
В `tools/list` per-op тулы несут сгенерированный из zod `inputSchema` (типы, enum'ы, `minLength`, `maximum`, `required`) — это заявленная ценность §11 («N-schema cost IS the feature»). Но `batch.requests[].args` объявлен как `{"type":"object"}` без всего этого, а `name` — свободная строка без enum по каталогу опов.

Следствие: батч из N вызовов статически СЛАБЕЕ, чем N отдельных вызовов — опечатка в имени опа или в ключе аргумента не отбивается на границе харнеса и всплывает только как `bad_args` в ответе. Это прямой стимул не пользоваться батчем, хотя CONTRIBUTING рекомендует «prefer one batch over N round-trips».

Варианты по возрастанию цены:

1. `name` → enum по актуальному каталогу опов (дёшево, ловит опечатку в имени).
2. `requests` → `anyOf` по опам (`{name: const "find_usages", args: <schema find_usages>} | …`) — полная типизация; раздувает схему батча примерно на размер каталога, можно прятать за `$defs` + `$ref`.
3. Минимум: `requests` `minItems:1` и пометка в description, что `apply`/`summaryOnly` игнорируются для read-опов.

Отдельно: верхнеуровневый `format` и per-request `format` имеют РАЗНУЮ семантику (результат SQL против продюсера) — в схеме это следует только из description верхнего поля, у per-request `format` описания нет вообще.

Смежное: [[t-029489]] — вариант 2 упирается в `$defs`, которые сейчас из отдаваемой схемы выбрасываются; [[t-595909]] — `minItems:1` из п.3 это ровно та потеря `min(1)`.

Пример, проходящий гейт харнеса и падающий только на диспатче:

```json
{"requests":[{"name":"find_usagez","args":{"nmae":"Orchestrator"},"as":"u"}],"sql":"SELECT * FROM u"}
```

Готово, когда: опечатка в имени опа внутри батча отвергается на границе, и принято решение по глубине типизации `args`.
