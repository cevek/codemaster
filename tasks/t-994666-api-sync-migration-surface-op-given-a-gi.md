---
id: t-994666
title: api:sync migration surface op — given a git-diff of the generated API layer, report the concrete call sites that break per changed/removed/renamed DTO field or endpoint, grouped by enclosing function (impact_type_error-style)
status: backlog
priority: low
tags:
  - dogfood
type: feat
complexity: L
area: schema
source: dogfood-jul
created: '2026-07-15T11:33:07.339Z'
---
**Context.** A common big task is migrating after an orval-style `api:sync` that renames/removes fields across the generated client (e.g. `ServiceItemAddonDto`/`SaleItemAddonDto` gain `addonId`; request bodies `addons:{code}`→`{id}`; `AppointmentTypeServiceDto.predefinedAddonCodes`→`predefinedAddonIds`; an op + its input DTO removed). The DRIVER lives in the generated layer + a diff between two openapi snapshots — codemaster had no path, so the agent hand-diffed `src/api/generated/{api,types}.ts` with git and chased tsc errors.

**Ask.** An op that, given a git-diff (or before/after) of the generated API surface, reports the migration surface: for each changed/removed/renamed symbol or DTO field, the concrete call sites that break, grouped by enclosing function, ideally with impact_type_error-style real diagnostics — "impact of an api:sync" in one shot. Composes existing ops: impact_type_error, member_usages (t-000175, now shipped — covers the "usages of DTO field X" sub-ask), construction_sites, importers_of.

Inbox source: 2026-07-07 (line 81). The member-access-usage sub-wish it also raised is now covered by member_usages.
