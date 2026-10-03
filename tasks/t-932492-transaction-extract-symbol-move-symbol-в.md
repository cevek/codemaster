---
id: t-932492
title: 'transaction: extract_symbol+move_symbol в один dest для потребителя с namespace-импортом (import * as M) плодит дубли namespace-импорта dest и ссылки <dest>_N'
status: backlog
priority: medium
tags:
  - mutation
  - transaction
type: bug
complexity: M
area: transaction
evidence: repro
author: f0182919
created: '2026-10-03T15:44:48.549Z'
---
## Repro (эталон /Users/cody/Dev/amiro @ d89515259, dry-run, codemaster 41f6c70)

`node src/bin.ts op transaction "$(cat chain8.json)" --root /Users/cody/Dev/amiro` — цепочка: `extract_symbol setNameTranslation` из `src/features/settings/forms/forms-builder-model.ts` в новый `src/features/settings/forms/forms-builder-i18n.ts`, затем 7× `move_symbol` (setDescriptionTranslation, setSectionTitle, setSectionDescription, setQuestionLabel, setQuestionHint, setQuestionPlaceholder, setFieldId) в тот же dest. Аргументы цепочки — в теле t-749107 (раздел замера).

Потребитель `src/features/settings/forms/FormBuilder/use-form-builder.ts` импортирует модель как `import * as M from '../forms-builder-model.ts'` и зовёт `M.setX(...)`.

Итог: гейт `clean=false`, 15 introduced — 8× `Duplicate identifier 'formsBuilderI18n'` (восемь строк namespace-импорта dest, по одной на шаг) и `Cannot find name 'formsBuilderI18n_2'…'_7'` в местах вызова.

Гейт отказал честно (не ложь), но цепочка неисполнима: каждый шаг добавляет свой namespace-импорт dest вместо переиспользования добавленного предыдущим шагом, а ссылки получают суффикс `_N`, которого нет ни в одном импорте.

Не проверено: воспроизводится ли на одиночном `move_symbol` (без transaction) в dest, который потребитель уже импортирует namespace-импортом — это отделит поведение LS «Move to file» от склейки оверлея в `TxnCompose` (`ops/transaction-compose.ts`) и нормализатора `foldSameModuleImports` (`plugins/ts/refactor/normalize/fold-imports.ts`).
