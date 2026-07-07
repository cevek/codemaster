---
id: t-273743
title: find_usages for a symbol imported from an EXTERNAL package (e.g. `find_usages {module:'yaml', name:'parse'}` → the repo's import+call sites)
status: backlog
priority: low
tags:
  - dogfood-jul
type: feat
complexity: M
area: impact-usages
created: '2026-07-07T20:06:45.227Z'
---
Inbox entry 28 (`task-manager`), 2026-07-04. `find_usages {name:'parseDocument'}` FAILs "no symbol named" because the symbol lives in `node_modules` (the `yaml` package), not the workspace. Wanted: "where does this repo use `<package>`'s export X" — `find_usages {module:'yaml', name:'parse'}` → the import + call sites, including aliased imports (`{parse as parseYaml}`) that grep misses. Today the only path is grep, which misses the alias — the exact case codemaster exists for.
