---
id: t-993754
title: impact_type_error masks the downstream blast radius when a trial edit degrades the edited symbol's OWN inferred type to `any` (zod value-type widening)
status: backlog
priority: medium
tags:
  - UNVERIFIED
  - dogfood-jul
type: bug
importance: medium
complexity: M
area: impact-usages
created: '2026-07-07T20:05:47.132Z'
---
Inbox entry 29 (`task-manager/track-f-config`), 2026-07-06. `impact_type_error` on `fieldSpecSchema` replacing `values: z.array(z.string()).optional()` with `values: z.array(z.union([z.string(), z.object({…})])).optional()` collapsed zod's inference of the whole `configSchema.superRefine((cfg,ctx)=>…)`: reported **14 introduced errors, all intra-file** (`cfg`/`ctx`/`spec`/`s` implicitly `any`, an index error) with `brokenFiles=0` downstream. The tool correctly warned `!! trial edit introduced error(s) in the edited file ITSELF — may be PARSE CASCADE`.

Net effect: the downstream blast radius is **masked** — `configSchema` infers `any` → dependents see `any` → no errors surface — so the op cannot answer "does an excluded file break?" for a zod value-type widening (the common shape in zod-first codebases: widen a `z.array` element type). A masked cascade currently reads like "no downstream breaks."

Ask: when a trial edit degrades the edited symbol's own inferred type to `any`/`unknown`, flag the downstream result **UNTRUSTWORTHY** (a distinct verdict, not just `clean=false`), since the intra-file cascade poisons the very inference the downstream check depends on. This is stronger than the existing PARSE-CASCADE note, which flags the edited file but still presents `brokenFiles=0` as if downstream were genuinely clean. UNVERIFIED on current `main`. Adjacent to t-000033/034/035 (impact_type_error caveats).
