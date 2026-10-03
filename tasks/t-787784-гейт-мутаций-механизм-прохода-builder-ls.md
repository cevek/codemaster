---
id: t-787784
title: 'гейт мутаций: механизм прохода (builder/LS) не едет вместе с вердиктом — post-apply выводит его заново из состояния после записи'
status: backlog
priority: low
tags:
  - gate
  - mutation
type: imp
complexity: S
evidence: reported
author: 0c78fe37
created: '2026-10-03T17:33:13.660Z'
---
`buildersFor` (`src/plugins/ts/program-gate.ts`) решает builder или LS для post-apply-перепроверки (`diagnosticsAcross`) заново: по ширине scope и `GateBuilders.follows`. Baseline той же программы в гейте мог прийти другим механизмом. Builder и LS читают один Program и равны по построению — паритет закреплён `test/differential/gate-builder-traps.test.ts`. Значит, сегодня это не ошибка, а то, что решение должно быть одно.

Минимальный исход: `GateResult` несёт механизм каждой программы рядом с `programs`, а `diagnosticsAcross(restrictTo)` его соблюдает. Если gate-state вытеснен из `afterGate` (4 слота), проход идёт через builder с родителем `disk`, а не через LS. Источник: архитектурное ревью t-378508.
