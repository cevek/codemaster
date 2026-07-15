---
id: t-320098
title: 'CLI ergonomics trio: (a) honor `root` inside the args JSON via flag-lift, (b) wire `--format json` (+ --debug) into the `op` path, (c) targeted error for `--root` placed BEFORE the op subcommand instead of the generic usage banner'
status: backlog
priority: low
tags:
  - dogfood
type: dx
complexity: S
area: platform
source: dogfood-jul
created: '2026-07-15T11:33:37.348Z'
---
Three CLI self-dev papercuts (the dogfood loop CONTRIBUTING.md points to), all on `node src/bin.ts op …`:

(a) **root-in-args rejected.** `op find_usages '{…, "root":"/abs"}'` → `bad_args: unrecognized 'root'`; the correct form is the `--root` flag. An agent naturally puts `root` in the args object (mirroring the MCP tool where root is a top-level param alongside args). Add `root` to the intake flag-lift (src/ops/intake/lift-flags.ts) so an in-args `root` is honored on the CLI path too, disclosed via Result.intake. (line 67)

(b) **--format json ignored.** The CLI `op` case in src/bin.ts (~line 254) builds the request without `format` and always renders dense text, so `--format json` is silently ignored — can't inspect the structured envelope (e.g. `truncated:{shown,total}`) from the self-dev loop. Wire `--format json` (+ maybe `--debug`) into the bin.ts op case, or document it MCP-only. (line 74)

(c) **flag-before-subcommand dumps generic usage.** `node src/bin.ts --root /path op search_symbol '{…}'` prints the full generic usage banner with no hint of what's wrong. Either accept `--root` in either position, or emit a pointed "put --root after the op args". (line 313)

Inbox source: 2026-07-07 / 2026-07-14 (lines 67 / 74 / 313).
