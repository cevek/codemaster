---
id: t-029489
title: tools/list отдаёт схемы с висячим $ref — toInputSchema выбрасывает $defs
status: backlog
priority: medium
tags:
  - mcp
  - schema
type: bug
complexity: S
area: platform
source: dogfood-jul
created: '2026-07-28T15:16:29.862Z'
---
`toInputSchema` (src/mcp/op-tools.ts:203) берёт из результата `z.toJSONSchema(op.argsSchema, {unrepresentable:'any', io:'input'})` только `properties` и `required`, отбрасывая верхнеуровневый `$defs`. Zod v4 для рекурсивного `JsonValue` выносит определение в `$defs` и оставляет `$ref: "#/$defs/__schema0"`, поэтому в `tools/list` уходит JSON Schema с недоразрешимой ссылкой.

Затронуты два опа, оба принимающие произвольный JSON — то есть ровно те, где валидация на границе и нужна:

- `feedback.example` → `{"$ref":"#/$defs/__schema0"}`
- `transaction.steps[].args` → `{"$ref":"#/$defs/__schema0","default":{}}`

`grep -rn '\$defs\|__schema0' src/` — ноль совпадений: `$defs` нигде не приклеивается обратно.

Последствие: строгий JSON-Schema валидатор (draft 2020-12) отвергает дескриптор тула целиком; мягкий молча принимает в это поле что угодно, то есть заявленный тип `JsonValue` на границе не проверяется. Оба исхода противоречат §11, где типизированная видимая схема — заявленная ценность per-op тулов.

Фикс: пробрасывать `$defs` (и прочие top-level ключи схемы помимо `type`/`properties`/`required`) в возвращаемый объект, либо инлайнить `$ref` перед отдачей.

Готово, когда: каждый сгенерированный `inputSchema` проходит валидацию мета-схемой с разрешением всех `$ref` — анти-дрейф-тест по всему каталогу опов.
