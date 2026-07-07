---
id: t-000120
title: "co-extract path-scrub is untested"
status: backlog
priority: low
type: bug
importance: low
complexity: S
area: scss
created: '2026-07-08T00:01:59.000Z'
---
**co-extract path-scrub is untested** — the `classifyForExtract`/`extractRules` catch blocks
now `scrubRoot` their thrown message (defensive: keeps "scrub on every failure exit" true by
construction), but there is no test repro of a co-extract throw that EMBEDS a path (the
taxonomy walk / CST clone don't surface `input.file` today). Add a scrub assertion when a
pathological throwing-with-path co-extract case surfaces. `bug`·`low`·`cx:S`
