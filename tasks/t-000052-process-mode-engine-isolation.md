---
id: t-000052
title: process`-mode engine isolation
status: backlog
priority: medium
parent: t-031282
type: feat
complexity: L
area: platform
created: '2026-07-08T00:00:51.000Z'
---
**`process`-mode engine isolation** — one child process per workspace (§2/§9): own heap +
`--max-old-space-size`, OS-reclaim-on-kill, real cross-workspace parallelism, and the
kill-on-deadline backstop that reaps a wedged engine/daemon (above). The daemon would own the
child engines. `feat`·`med`·`cx:L`

**Why this is the keystone (motivation).** This is how you *safely* work with a genuinely large
project (10k–20k+ files) — where warming the LS is UNAVOIDABLE for any semantic op
(find_usages/rename/expand_type have no cheap substitute). The pre-warm size guard (t-333163)
only avoids the NEEDLESS warm (a throwaway `search_symbol` discovery query → redirect to the
no-program `symbols_overview`); it does NOT and cannot make the NEEDED warm safe. Isolation is
what does: warm the big program in a child process that (a) can't crash the daemon (crash-isolation —
an in-process OOM is uncatchable and kills the shared daemon, t-895142/t-167395), (b) is
memory-bounded (`--max-old-space-size` + the §9 memory governor), (c) is OS-reclaimed on kill and
idle-TTL-reclaimed so a one-off warm doesn't squat the user's RAM. Unblocks t-167395 (name-addressed
OOM-crash) directly, and is the hard-guarantee half the never-hang epic needs beyond the acute
walk fix. Guard + isolation are complementary: guard = avoid the needless warm; isolation = make
the needed warm safe.
