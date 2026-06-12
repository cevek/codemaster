# Spec: the `feedback` op — agents file bugs & wishes in-band

Status: **approved**. Do not start while the
[spec-feedback-polish.md](spec-feedback-polish.md) stages are in flight — this is a
small standalone unit for right after (it touches `mcp/schema.ts` guidance and the
FAIL render, which Stage 1 also touches).

## 1. Problem & idea

Field agents hit bugs and missing capabilities mid-task, and that knowledge
evaporates with the session. "Write a wish file" instructions don't work: field
agents run in _other_ repos (a wish file there pollutes a stranger's git tree and
scatters the inbox across machines/repos), and prose instructions decay under task
load (observed: agents grep past explicit steering).

So the channel is an **op** — in-band, self-serve, available wherever the MCP server
is connected, with daemon-attached context no instruction-following agent could
assemble. One global inbox on the user's machine.

## 2. Fixed decisions

- **Op name `feedback`**, daemon-level, `requires: []` (no plugins), available in
  every repo — even one with zero active plugins.
- **Args** (zod, fail-fast): `kind: 'bug' | 'wish' | 'friction'` ·
  `title: string` (1–120) · `detail: string` (1–4000) ·
  `example?: JsonValue` (the call that failed, or the call the agent wishes existed).
- **Auto-attached by the daemon** (never asked of the agent): timestamp (via the
  injectable `Clock` — no `Date.now`, §16), codemaster version, repo root/repoId,
  active plugin ids@versions, op-catalogue names. Nothing else — no transcripts, no
  file contents.
- **Storage: plain markdown, append-only** — `~/.codemaster/feedback/inbox.md`
  (global, not per-repo — one triage point; the repo is part of each entry). The
  inbox is read by a human/triage agent, so human-readable beats machine-parseable.
  One entry = one templated block:

  ```md
  ## [wish] one-line title — 2026-06-12T10:33Z

  repo=/Users/x/dev/amiro · cm=0.1.0 · plugins=ts@0.1.0,scss@0.1.0

  Free-text detail (what was attempted, what was expected).

  ​`json example
  { "name": "find_usages", "args": { … } }
  ​`
  ```

  Append goes through a wrapped `support/fs` helper → a write failure returns
  `ToolFailure`, never a crash (§3.6).

- **Result:** `ok { recorded: true, at: '~/.codemaster/feedback/inbox.md' }` — the
  agent sees where it landed.
- **Not a mutating op** in the §7 sense: it never touches the inspected repo's tree
  (oracle below), no `apply` flag — recording _is_ the action.

## 3. Discoverability — affordance at the moment of friction

1. `SERVER_INSTRUCTIONS` + status guidance: one line each —
   `Hit a bug or missing capability? op({name:'feedback', args:{kind:'wish', title:'…', detail:'…'}})`.
2. **FAIL render trailer** (`format/render/render-result.ts`): on `FAIL` results
   only (not `partial` — partial is honest success), append one short clause:
   `— blocked? file it: op({name:'feedback', …})`. This is the lever that actually
   fires: the nudge lives at the point of pain, not in a doc read once.
3. The op's own `notes` in the status catalogue explain when to file (see
   [spec-status-as-the-doc.md](spec-status-as-the-doc.md) — `status` is the doc;
   there is no separate agent guide).
4. The structured-example + anti-drift test machinery from polish Stage 1.1 applies
   to this op like any other.

## 4. Triage loop (no tooling in v1)

The inbox is a markdown file; the maintainer (or a session agent) reads
`~/.codemaster/feedback/inbox.md`, turns entries into specs/wishlist items, and
truncates or archives the file. A `codemaster feedback ls` CLI is wishlist, not v1.
An optional user-level harness command (`/cm-feedback` in `~/.claude/commands/`,
outside this repo) can prompt an agent to harvest its session friction through this
op at session end — a complement, not a dependency.

## 5. Tests (§16 — independent oracles)

| Claim                                                  | Oracle                                                                                                                           |
| ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| entry appended in the template shape with auto-context | read the file back; assert the `## [kind] title — ts` heading, the context line, and that prior entries are intact (append-only) |
| the inspected repo's tree is untouched                 | `git status --porcelain` empty after the call (the §7 edit-safety oracle reused)                                                 |
| unwritable inbox dir → `ToolFailure`, daemon up        | point HOME/dir seam at a read-only path                                                                                          |
| args boundary                                          | zod rejects oversize title/detail with pointed messages; error carries a valid example (polish 1.2)                              |
| FAIL trailer present on FAIL, absent on ok/partial     | render unit test                                                                                                                 |

## 6. Non-goals

No network/telemetry — the inbox never leaves the machine. No dedup/rate-limiting in
v1 (revisit if agents spam). No read-back op (`status` does not list inbox contents —
it's the maintainer's file, not the agent's). No per-repo inbox files.
