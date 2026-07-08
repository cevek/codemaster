---
id: t-902277
title: 'impact_type_error widen detection is whole-type/return only: a deep-member widen to any ({cb:()=>void}→{cb:any}) or an index-signature mask is not detected'
status: backlog
priority: low
type: bug
complexity: M
area: impact-usages
source: dogfood-jul
created: '2026-07-08T11:43:18.716Z'
---
From t-534369 (Case B). collapseOf detects a whole-symbol-type OR function-return collapse to any, but NOT a deep-member widen: a const typed { cb: () => void } → { cb: any } keeps an object symbol type, so cb(wrongArgs) downstream is masked and not flagged; same for an index signature { [k]: number } masking 'property doesn't exist'. Repro sketch: baseline export const api = { run: (n:number)=>n }; edit export const api = { run: JSON.parse('{}') } → api.run(wrongArgs) masked. fix-locus: src/plugins/ts/overlay-type.ts collapseOf (recurse into member/index-signature types).
