---
id: t-147277
title: 'post-apply: расширенный рекчек (claimDivergence) остался без e2e, доходящего до настоящего расхождения membership'
status: backlog
priority: medium
tags:
  - dogfood-nov
created_by_session: s-207994
type: infra
complexity: S
area: ts-refactor
audience: internal
evidence: reported
author: mi-71ed3970
created: '2026-11-16T12:55:21.100Z'
---
## Симптом
`test/e2e/post-apply-verify.test.ts` проверял путь «overlay рутует dest, на диске его нет ни в одной программе → `claimDivergence` расширяет рекчек → ломка в незаписанном файле → откат». Форма теста — перенос unimported `declare global` в `out/` вне всех glob. После t-401540 этот dest достаётся программе-держателю источника как content (`OverlayEntry.root:false`), поэтому гейт отказывает ДО записи; тест переписан на отказ. Путь расширения (`claimDivergence` в `src/plugins/ts/gate-membership.ts`, его потребитель `verifyAfterWrite` в `src/ops/post-apply-verify.ts`) остался без e2e, доходящего до реального расхождения. Вариант с glob-owned gitignored dest (t-433767, `.gitignore: src/gen/`) на этой фикстуре расхождения не дал (applied clean); причина не установлена.

## Минимальный исход
e2e, где после записи `claimDivergence` непуст и расширенный рекчек откатывает доказанную ломку: структурная запись (tsconfig/.gitignore) или gitignored dest, найденный по чтению `loadFileList` + `ignored-set.ts`.
