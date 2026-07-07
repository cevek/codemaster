---
id: t-000119
title: indented `.sass` → parse failure (half-support)
status: backlog
priority: low
type: bug
complexity: M
area: scss
created: '2026-07-08T00:01:58.000Z'
---
**indented `.sass` → parse failure (half-support)** — the index gate accepts `.sass` (to match
the css-module usage scanner's `/\.(scss|sass|css)$/`), but postcss-scss parses brace SCSS, not
indented Sass — so an indented `.sass` sheet surfaces an honest `parseFailure` (no classes
extracted), never a silent skip. Its `s.foo` usages are still seen by the ts tier, so its
classes are invisible to `scss_classes`/`find_unused` while usages are counted — an honest
half-support. Full indented-sass support needs a real indented-sass parser (dart-sass /
`sass`). `bug`·`low`·`cx:M`
