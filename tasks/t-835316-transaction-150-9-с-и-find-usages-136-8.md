---
id: t-835316
title: transaction 150.9 с и find_usages 136.8 с на amiro в бодрствовании — работа не уложилась в кооперативный дедлайн 120 с
status: backlog
priority: high
tags:
  - daemon
  - never-hang
type: bug
complexity: M
relates:
  - t-833715
evidence: measured
author: aecc37d1
created: '2026-10-06T13:28:23.562Z'
---
## Наблюдение
usage-лог (`~/.codemaster/usage`), репо `/Users/cody/Dev/worktrees/amiro/pv2-kz-final`, 2026-10-06 (+0500), топология `mcp --in-process` + авто-эскалация в `process`:
- `transaction` {extract_symbol useUndoPresale + move_symbol useOfferPresaleUndo → src/api/hooks/useCrmUndo.ts, apply:true} — старт 10:39:03, 150938 мс, FAIL timeout «isolated engine did not reply in 150000ms — killed it». Кооперативный op-дедлайн 120 с (`daemon.opDeadlineSeconds`) не вернул partial до kill'а.
- `find_usages {name:personDisplayName}` — старт 11:16:16, 136760 мс, УСПЕХ при op-дедлайне 120 с. Шёл первым после kill'а — включает холодный спавн дочки + прогрев.
Машина бодрствовала в обоих окнах (pmset). Сон как причина исключён (в t-833715 460 с объяснены сном).

## Вопрос
Где время уходит мимо `createDeadline` движка: сборка программ/гейт typecheck (не отменяемы, §19), startup дочки (handshake в `createProcessHost` до старта request-таймера), наш синхронный код. Артефактов нет: `~/.codemaster/pv2-kz-final-*` не существует (debug.log не писался). Причину устанавливать репро на копии amiro (`cp -cR`) с `CODEMASTER_DEBUG` на коммите агента.
