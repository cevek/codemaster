# spec-wedged-recovery — reaping a permanently-wedged daemon (t-000051)

Marker: `spec-wedged-recovery`. Extends spec-daemon-singleton (§2) and spec-daemon-cli.

## 1. The gap this closes

The singleton reaps orphans via the daemon's idle-exit + the bridge's per-request reply deadline. A
**permanently-wedged** daemon — one that accepts connections but never replies (a synchronous spin,
or, in the default in-process isolation, a heavy op blocking the shared loop) — is not covered: its
own idle loop is wedged too, so it can't self-exit, and it holds the socket so no fresh daemon can
bind. Bridges fail honestly (reply-deadline → `ToolFailure`) and the agent falls back, but the
process lingers until killed. `process`-mode engine isolation (t-000052) reaps a wedged ENGINE
CHILD; it does NOT reap the daemon's OWN front door. This spec does.

## 2. Kill-target-hint pidfile (`support/pidfile/`)

The daemon drops `<socket>.pid` — `{pid, socket, version, startedAt}`, atomic temp-then-rename —
**after a successful bind** (a bind-race loser threw on `listen()` and never writes) and **removes it
on graceful shutdown**. So a lingering pidfile unambiguously marks a daemon that did not exit
cleanly. It is a **kill-target HINT, never a liveness oracle**: the socket is the sole liveness
authority (§3.5); the pidfile is consulted only AFTER the socket has proven unresponsive, purely to
learn WHICH pid to signal. `write.ts` (write/remove/path), `read.ts` (zod-validated read → record |
`undefined`), `liveness.ts` (`isProcessAlive` / `sendSignal` — wrapped `process.kill`). Daemon-agnostic;
`process`-mode child supervision (t-000052) can reuse the primitives.

## 3. Force-recover (`daemon/force-recover.ts`), driven by `stop`/`restart`

When a management verb's graceful `shutdown` message goes unanswered past the deadline, it escalates:

1. Read the pidfile → no usable hint (absent / invalid / **socket ≠ the managed socket**) → `no-target`,
   caller degrades to the honest manual-kill hint.
2. `isProcessAlive(pid)` false → `already-gone` (the wedge resolved; clear the stale pidfile).
3. **Anti-recycle guard:** re-read the pidfile immediately before signalling; a changed pid →
   `target-changed`, abort (never signal a possibly-innocent recycled pid). A narrow TOCTOU window
   remains (recycle between the last read and the signal) — disclosed, mirroring the convergence
   "narrow residual race" (§19).
4. `SIGTERM` → bounded grace → still alive → `SIGKILL` → bounded confirm-poll. `killed` on confirm,
   else `still-alive` (honest "kill -9 X"). SIGKILL is the real backstop — a sync-spin can't service
   SIGTERM. A REF'd `setInterval` keep-alive holds the event loop open across the poll (the real
   `Clock`'s timers are `unref`ed and the wedged connection is already closed, so without it Node
   exits 0 mid-wait and abandons the SIGKILL).

**Convergence invariant:** force-recover never unlinks the socket or respawns. `restart` respawns
through `connectOrSpawnDaemon`, whose re-probe is what keeps a sibling's freshly-bound daemon from
being unlinked. The kill only removes the (stale) pidfile.

## 4. Bridge wedge-probe (`daemon/remote-orchestrator.ts`, read path)

On a reply-timeout the bridge fires ONE short-deadline `daemon-info` liveness ping (a pure read
touching no engine). Any reply — even an error from an older daemon — proves the front door services
requests → "busy/slow (still responsive)". A second timeout (or a closed link) → the front door is
**UNRESPONSIVE**, and the honest failure is enriched with a `codemaster daemon restart` steer. The
message says "unresponsive", NOT "wedged": in the default in-process mode a genuinely busy daemon
can't answer either, so the signal is ambiguous by construction. The bridge **never auto-kills** — a
bridge-triggered automatic daemon kill without reconnect would brick the live session; it is deferred
(t-783490, needs bridge-reconnect or an explicit next-session scope). The single-listener transport
means the probe reuses the bridge's own pending/onMessage machinery, not a second handler.

## 5. Tests (§16)

- **Force-recover units** — injected liveness/signal/pidfile seams + manual clock: the guard branches
  and the SIGTERM→SIGKILL escalation, each bounded (the clock-drive cap is the no-spin backstop).
- **Pidfile units** — real fs (write/read round-trip; corrupt/absent/invalid → no hint) + a real
  spawned process for the signal primitives.
- **Manage mapping units** — injected `forceRecover`: each outcome → correct verb code/lines; restart
  proceeds after a force-kill.
- **Bridge-probe units** — fake connection + manual clock: front-door-answers → busy/slow;
  front-door-silent → UNRESPONSIVE + restart steer (both `request` and `status`).
- **A1 lifecycle** — `serveDaemon` writes the pidfile at bind, removes it on graceful shutdown.
- **SIGSTOP real-spawn smoke** — a real daemon frozen with SIGSTOP (the true accepts-but-never-replies
  wedge, no production test hooks); `daemon restart` force-kills it (old pid provably gone) and binds
  a fresh one. Catches the unref'd-timer / teardown bugs a fake clock cannot.

## 6. Scope

DONE: A1 (pidfile lifecycle) + A2 (management-verb force-recover) + A3 (bridge detection + steer),
consuming B1 (process-host child-kill, t-000052) for in-session engine-wedge recovery. DEFERRED:
B2 — automatic bridge-triggered whole-daemon recovery (t-783490).
