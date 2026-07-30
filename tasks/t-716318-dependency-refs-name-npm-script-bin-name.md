---
id: t-716318
title: dependency_refs {name} / npm:<script> + bin:<name> find_usages targets — resolve a tool or script across package.json, hooks, CI, ignore files and prose
status: backlog
priority: medium
parent: t-437713
type: feat
complexity: L
area: platform
source: dogfood-jul
audience: external
evidence: reported
created: '2026-07-30T11:22:20.005Z'
---
The addressing half of the epic: the nodes exist and are referenced, they are simply not TS symbols.

    dependency_refs {name:'lint-staged'}

→ every declaration site (`dependencies`/`devDependencies`, a config block keyed by the tool name, workspace
package.jsons), every TS import, every mention in scripts / `.husky/*` / CI workflows / ignore configs, and
prose mentions in tracked `.md` flagged SEPARATELY as unverified text (a doc claim is not a reference).

Sibling addressing: let `find_usages` accept `npm:<script>` and `bin:<name>` targets, with the same
proof-carrying output — "who references the npm script `format`?" spans package.json (`fix-and-check`
composes it), `.husky/*`, README.md, CLAUDE.md.

Why the grep fallback is unsound here in the way the spec warns about for symbols: one tool is spelled
`lint-staged` in package.json, `lintstaged` in a script, `npx lint-staged` in a hook.
