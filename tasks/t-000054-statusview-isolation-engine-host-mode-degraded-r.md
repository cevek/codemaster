---
id: t-000054
title: StatusView.isolation` репортит engine-host-mode, бессмысленный на degraded remote-пути
status: backlog
priority: low
type: infra
complexity: M
area: platform
created: '2026-07-08T00:00:53.000Z'
---
**`StatusView.isolation` репортит engine-host-mode, бессмысленный на degraded remote-пути** — поле = режим транспорта движка (`config.daemon.isolation`), форвардится от daemon; healthy-путь хардкодит `'in-process'` (orchestrator.ts:187), `'process'` не реализован (отклоняется на спавне, orchestrator.ts:254-260). На недостижимом daemon (`degradedStatus`) спросить некого, любой конкретный тег произволен: `'process'` — over-claim несуществующего режима + флип от достижимости; `'in-process'` просто совпадает с единственным реализованным режимом и healthy-путём (выбран). Честный "unknown" потребовал бы редефайна поля сквозь healthy-path + докстринг + render — кросс-каттинг, вне скоупа. Косметика; `engines:0` + `workspaceError` уже несут факт сбоя. `infra`·`low`·`cx:M`
