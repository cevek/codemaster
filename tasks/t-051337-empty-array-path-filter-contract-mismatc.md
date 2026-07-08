---
id: t-051337
title: 'Empty-array path-filter contract mismatch: usages.ts/search.ts treat pathInclude:[] as EXCLUDE-ALL (no length guard) while passesPathFilter treats it INCLUDE-ALL; find_usages schema lacks .min(1) so {filter:{pathInclude:[]}} silently returns ZERO usages'
status: in-progress
priority: medium
type: bug
complexity: S
area: impact-usages
source: dogfood-jul
created: '2026-07-08T11:20:22.338Z'
---
Flagged by Track A (Wave 4). src/plugins/ts/usages.ts:80-81 and search.ts:76-77 gate on 'pathInclude !== undefined' with NO length guard → a defined-empty pathInclude:[] means EXCLUDE-EVERYTHING there, vs INCLUDE-EVERYTHING in the new common/glob passesPathFilter family. AND find-usages.ts:56-57 schema lacks '.min(1)' (search-symbol.ts:51-52 has it), so find_usages {filter:{pathInclude:[]}} passes zod and returns ZERO usages = a latent silent surprise (reads as 'no usages'). Fix: decide the empty-[] contract, add .min(1) to find_usages filter schema for parity, then fold usages.ts/search.ts into passesPathFilter. DO NOT fold blind — the empty-[] semantics differ.
