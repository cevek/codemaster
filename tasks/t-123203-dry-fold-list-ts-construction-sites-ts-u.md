---
id: t-123203
title: 'DRY: fold list.ts/construction-sites.ts/unused-exports.ts path gates into passesPathFilter (list.ts drifted, missing length>0 guard — masked by schema, no live bug)'
status: backlog
priority: low
type: dx
complexity: S
area: impact-usages
source: dogfood-jul
created: '2026-07-08T12:37:11.676Z'
---
From t-051337 copy-paste review. path-filter.ts's header already names all 6 ops as routing through passesPathFilter, but 3 sites still hand-roll: construction-sites.ts:249 + unused-exports.ts:159 (exact copies, already carry length>0 guard → correct, DRY-only) and list.ts:33-38 (drifted near-dup MISSING the length>0 guard — masked today by list's schema .min(1), so no live bug). Fold all three into passesPathFilter for consistency + drift-hardening. No behavior change expected.
