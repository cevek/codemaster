---
id: t-617982
title: "`batchToolSchema` is non-strict: a typo'd top-level batch key (`sqll`) is silently stripped and the call runs as a plain batch with no diagnostic — the one place the envelope gate does not follow §7's own no-silent-drop rule"
status: backlog
priority: medium
tags:
  - agent-surface
  - dogfood
type: bug
complexity: S
area: platform
source: dogfood-jul
created: '2026-07-28T12:36:51.670Z'
---
`batchToolSchema` (`src/mcp/schema.ts`) is a plain `z.object`, so zod strips unknown top-level keys
instead of rejecting them. `{"requests":[…],"sqll":"SELECT 1"}` therefore validates, drops the
misspelt key, and runs as a batch with NO join — the agent gets a plain multi-section result and no
indication that the SELECT it wrote was discarded.

That is the §7 intake contract inverted. Everywhere else a key that is not a known alias fails the
canonical gate with a did-you-mean, precisely because "silently stripped" is an input-lost lie; the
op-args gate does this correctly. The batch ENVELOPE is the one shape that does not.

Worst on an anti-join, where the dropped key is the whole point of the call: the agent reads the
per-request sections and concludes the join returned nothing to filter.

Affects BOTH front doors — the MCP `batch` tool and the CLI `batch` command share this schema, so
the fix is one `.strict()` plus a did-you-mean over the known keys (`requests`, `root`, `sql`,
`return`, `format`, `verbosity`). Check `normalizeBatchArguments` first: it passes unknown keys
through, so strictness must land after normalization, not before.

## Второе расхождение в том же `batchToolSchema`: потеря `min(1)`

zod объявляет `requests: z.array(opRequestSchema).min(1)`; руками написанный `inputSchema` (`src/mcp/schema.ts:99`) — `{"type":"array","items":{…}}` без `minItems`. Пустой `requests` проходит гейт харнеса и падает только на zod.

Общий с этой задачей корень: `status` и `batch` — единственные два тула, чьи `inputSchema` написаны РУКАМИ, а не сгенерированы из того же zod, что валидирует. У per-op тулов расхождение невозможно по построению; у этих двух его ничто не ловит. Лечится либо генерацией из zod, либо анти-дрейф-тестом на пару схема↔zod.

Связано: [[t-568278]] (типизация `requests[].args` / `name` в том же дескрипторе), [[t-000016]] (в `status` тем же способом потерян `format`).
