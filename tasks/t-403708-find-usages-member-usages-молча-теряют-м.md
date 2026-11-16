---
id: t-403708
title: find_usages / member_usages молча теряют межпакетных потребителей, импортирующих символ через workspace-пакет (снапшот без node_modules)
status: backlog
priority: high
parent: t-982648
tags:
  - UNVERIFIED
  - dogfood
  - dogfood-nov
assigned_to_session: s-207994
type: bug
complexity: M
area: multi-program
audience: external
evidence: reported
author: mb-ce356acc
assignee: mi-c8278b4a
created: '2026-11-16T09:41:50.537Z'
---
## Симптом
На read-only снапшотах claude-ui (дерево без `node_modules`) `find_usages` по `name+file` возвращает только объявление (+ in-file use), а `member_usages` — 0 мест, хотя реальные потребители в `apps/server` / `apps/web` импортируют символ через `@claude-ui/protocol` / `@claude-ui/agent-core`.
Примеры: `ChatPromptPart` (packages/protocol/src/chatPrompt.ts → apps/web ChatPrompt.tsx), `systemText` (agent-core → agent-anthropic/codex/grok/agy), `pickReviewers` / `reviewHeadText` / `reviewerPickOf` (protocol reviewerPick.ts → apps/server mesh/oneShotTools.ts), `RoleInfo.family` (→ skillTools.ts, oneShotTools.ts). `mergeDeclarations:true` показывает вызов как отдельный alias — т.е. импорт резолвится в ДРУГОЙ символ (вероятно, workspace-спецификатор без node_modules-симлинка не доходит до исходника).

## Почему это ложь
`complete=false` выставлен, но `undiscoveredPrograms` не называет `apps/server/tsconfig.json` — причина неполноты указана неверно, агент не может догадаться, что теряются именно workspace-ссылки (§3.4/§3.6).

## Минимальный исход
Честная половина: когда workspace-спецификатор (`@scope/pkg` из `workspaces`/pnpm-workspace) не резолвится в файл репо — дисклоузить это в ответе (какие спецификаторы, какой пакет), а не молчать. Полная половина (резолв workspace-пакета к его исходнику без node_modules через package.json `exports`/`main`) — развилка, отдельно.
Смежное: `construction_sites` в таком снапшоте видит все типы как `any` (f-cr5yykmpslke).

## Фрикшены
f-yryfwts6foiq, f-ydob65mx2la6, f-73no7yqc753m, f-5f4bg2yo464s, f-6mlodylvorjt, f-o53yqwdk5byt, f-jpyvrdskwifw, f-cr5yykmpslke
Inbox: «find_usages omits known re-exported workspace consumers» (2026-11-16T06:26), «find_usages в snapshot не связывает exported declaration с workspace consumer» (2026-11-16T08:16), «member_usages(RoleInfo.family) возвращает 0» (2026-11-16T08:45).

Источник — журнал фрикшенов claude-ui и/или inbox `~/.codemaster/feedback/inbox.md`, ноябрь 2026. Репро на текущем main не снято (тег UNVERIFIED): первым шагом — воспроизвести.
