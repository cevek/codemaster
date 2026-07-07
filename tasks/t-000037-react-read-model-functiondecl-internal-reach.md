---
id: t-000037
title: 'react read-model: `FunctionDecl` internal-reach'
status: backlog
priority: low
type: imp
complexity: S
area: phase-5
created: '2026-07-08T00:00:36.000Z'
---
**react read-model: `FunctionDecl` internal-reach** — `react/unused-props.ts` + `react/detect.ts`
import `FunctionDecl` from the ts plugin's internal `function-declarations.ts` rather than the public
`ts/plugin.ts` barrel (which re-exports `JsxCallSitesView`/`ParamTypeMembersView` but not
`FunctionDecl`). Re-export it for §5-L3 consistency. `imp`·`low`·`cx:S`
