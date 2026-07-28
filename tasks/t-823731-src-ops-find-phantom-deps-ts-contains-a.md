---
id: t-823731
title: src/ops/find-phantom-deps.ts contains a literal NUL byte, so every grep-based tool silently treats it as binary and skips it
status: backlog
priority: medium
tags:
  - debt
type: bug
complexity: S
area: platform
source: dogfood-jul
created: '2026-07-28T13:00:19.928Z'
---
`src/ops/find-phantom-deps.ts` carries a literal NUL byte at offset ~7246 — a composite map key
written as an actual control character rather than an escape sequence:

    `${importerPkg}<NUL>${site.packageName}`

`file` and `grep` therefore classify the file as binary and skip it SILENTLY. Any grep-driven sweep
over the repo — an agent's, a codemod's, a CI lint that shells out to `grep` — is blind to this one
op and reports success rather than a skip.

The fix is to write the separator as an escape (`'\x00'` in the string literal) so the source stays
plain text while the runtime key is byte-identical.

Found while building the structural oracle in `test/unit/refusal-navigation.test.ts`. That oracle is
NOT affected — it uses `readFileSync(…, 'utf8')`, so the op is read and included normally — which is
the point: the blindness is confined to external text tools, which is what makes it easy to miss.
