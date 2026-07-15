---
id: t-509002
title: Model import.meta.glob patterns in the reference graph — expand a glob call to its resolved file set so find_usages/impact see glob-wired entry points
status: backlog
priority: low
tags:
  - dogfood
type: feat
complexity: M
area: multi-program
source: dogfood-jul
created: '2026-07-15T11:33:11.800Z'
---
In Vite/React repos, `import.meta.glob('/projects/*/*/*/**/*.html', {...})` is often the real entry point wiring a set of assets/modules into the app, but it's invisible to codemaster: find_usages/find_definition can't tell which files a glob resolves to, and construction_sites/impact don't see the glob as a consumer of matched paths.

**Ask.** A `glob_matches` op (or teach find_usages to expand a glob call into its resolved file set) so an agent can answer "what does this glob pull in, and what breaks if I add/rename a file under projects/" without shelling out. Encountered building a design-variant browser that trees HTML files discovered via import.meta.glob.

Inbox source: 2026-07-08 (line 94).
