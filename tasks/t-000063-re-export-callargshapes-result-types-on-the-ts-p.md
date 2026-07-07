---
id: t-000063
title: "re-export `callArgShapes` result types on the `ts` public surface"
status: backlog
priority: low
type: dx
importance: low
complexity: S
area: platform
created: '2026-07-08T00:01:02.000Z'
---
**re-export `callArgShapes` result types on the `ts` public surface** (feedback) — `plugins/ts/plugin.ts`
re-exports `CallMatchSpec` but not the result types (`ValueShape` / `ValueProp` / `ShapedCall` /
`CallArgShapesResult`, in `call-scan-shared.ts`). A framework-plugin consumer derives them via
`ReturnType<TsPluginApi['callArgShapes']>` + indexed-access (works, keeps the public-method contract —
the idiom i18n uses for `literalCalls`). A one-line `export type { … } from './call-scan-shared.ts'`
lets authors name the discriminated union directly. Hit building `react-query`; future framework
plugins (zustand / tanstack-router) hit the same. `dx`·`low`·`cx:S`
