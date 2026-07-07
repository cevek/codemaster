---
id: t-000175
title: Member-level `find_usages
status: backlog
priority: medium
type: feat
complexity: L
area: impact-usages
source: dogfood-jul
created: '2026-07-08T00:02:54.000Z'
---
**Member-level `find_usages`** — trace readers of a specific object-type FIELD (e.g.
`GroupRow.site`); today `find_usages` on a type finds the TYPE, not a named `.field` member
(role:read/write is syntactic). Checker-backed. `feat`·`med`·`cx:L`

---
**Dogfood-jul (2026-07): the headline use case is a "field read-site audit."** Inbox entry 12
(`code-diff`, reader-v2): enumerate every site that READS a specific interface field —
`Node.fullHash`/`.structHash`/`.unitHash`/`.shapeHash`/`.ordered` — to decide per-site migration.
`find_usages` targets SYMBOLS, not FIELD reads, so it fell back to two greps (member access
`\.(fullHash|…)` PLUS destructured `\{[^}]*fullHash`) with completeness reasoned by hand — exactly
the silent-miss class the tool exists to remove (an aliased/destructured/re-exported read never
shows). A single authoritative query (member + destructured reads, proof spans + truncation marker)
replaces the sweep. Scope must include **destructured** reads (`const { fullHash } = node`).

Adjacent-but-distinct: **resolving a member BY NAME as the op target** (entries 22 `IdGen.next`
type-alias member, 41 `Session.setModel` class method) — `find_usages {name:'next', file:…}` FAILs
"no top-level declaration named 'next'"; only `file:line:col` works. The shared `resolve-target.ts`
`name`+`file` → `resolveNameInFile` branch may already cover a unique in-file member — verify, and if
not, resolve a member by `name`+`file` (unique → proceed; several → candidate list) so callers needn't
hand-compute a column. That is the *addressing* side; this task is the *usage-discovery* side.
