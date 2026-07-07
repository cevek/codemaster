---
id: t-375096
title: expand_type truncates object members with "… N more …" even at verbosity:full — no `!! OUTPUT CAPPED` marker, and `full` should be complete
status: done
priority: medium
type: bug
complexity: S
area: render
source: dogfood-jul
created: '2026-07-07T20:06:40.729Z'
---
Inbox entry 45 (`backoffice2`), 2026-07-06. `expand_type` on a 29-member `const UserRole` at `verbosity:'full'` rendered the `type:` block as `readonly Admin:"admin"; … (15 shown) … ; … 13 more …; readonly TPReviewer:"tp-reviewer";` — dropping 13 of 29 members mid-object. `expand_type` is the op you reach for precisely to see the RESOLVED members, and a reader who misses the `… N more …` marker concludes those members don't exist.

Note the member count (29) is **below** the `memberLimit` default (40), so this is the **dense render char-cap** collapsing members, not `memberLimit` — i.e. the `RENDER_CHAR_CAP`/`SPAN_TEXT_CEILING` path (cf. t-000008), which uses a soft `… N more …` rather than the honest `!! OUTPUT CAPPED` convention. In this case the full list was recoverable from the separate `constituents (29)` section, but that only exists for a union-of-literals — a genuine object/interface with 29 distinct-typed members would be lossy.

Asks: (1) at `verbosity:'full'` do not truncate the member list — `full` means complete; (2) if a cap must remain, apply the `!! OUTPUT CAPPED` marker (not a cosmetic `… N more …`) so dropped members are unmistakable; (3) optionally expose `maxMembers`. Adjacent to t-000160 (expand_type render bugs) and t-000169 (enum member value omission).
