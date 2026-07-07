---
id: t-000103
title: "extract/move_symbol: cosmetic double blank line after the import block (no-doc case)"
status: backlog
priority: low
type: dx
importance: low
complexity: S
area: ts-refactor
created: '2026-07-08T00:01:42.000Z'
---
**extract/move_symbol: cosmetic double blank line after the import block (no-doc case)** — the LS
can emit `import …\n\n\nexport const X` (two blank lines) in the extracted/moved block when the
symbol has no leading doc. LS-emitted, not detached by our fix; the project's own prettier collapses
it to one blank line on apply (mutating ops format), so it is invisible in real repos and only shows
in fixtures without a project prettier. Known-cosmetic, prettier-handled. `dx`·`low`·`cx:S`
