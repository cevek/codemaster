# Spec: daemon management CLI — `codemaster daemon <start|stop|restart|status>`

Status: **implemented**. Adds a user-facing control surface for the singleton daemon
(spec-daemon-singleton). Lives in `daemon/manage.ts` (the verb implementations, pure socket
clients) + `bin.ts` (the `daemon` sub-router) + a small protocol extension (`daemon/protocol.ts`).

## 1. Problem

The singleton daemon is reaped only by idle-TTL self-exit (spec-daemon-singleton §3); there is no
management surface — stopping it means `pkill`, and there is no liveness query. Two concrete pains:

1. **Stale code after an edit.** The self-staleness banner (§3.6) correctly DETECTS a daemon serving
   pre-edit behavior, but a bridge reconnect re-attaches to the SAME stale daemon on the same socket
   — the daemon must be killed for the next bridge to spawn a fresh one. `restart` is that command.
2. **No honest "is it up / what is it doing".** An agent had no bounded way to ask.

## 2. The verbs

The `daemon` command is a sub-router. `serve` is the INTERNAL long-lived verb the bridge spawns
(spec-daemon-singleton); it needs an orchestrator and stays in `bin.ts`. `spawn-daemon.ts` spawns
`codemaster daemon serve`. The management verbs are pure socket clients (no orchestrator):

- **`status`** — one fail-fast `connect` probe. No socket / ECONNREFUSED → honest "no daemon
  running". Connected → a `daemon-info` request (pid, uptime, engines, warm roots, source-staleness)
  - the socket path. A daemon that accepts but never replies → honest "UNRESPONSIVE" after the
    deadline; an old daemon that rejects the new kind → "speaks an older protocol — restart".
- **`start`** — already up → "already running (pid X)". Else `connectOrSpawnDaemon` (the same
  race-safe bind-or-connect the bridge uses) → "daemon started (pid X)"; spawn-budget overrun →
  honest "failed to start".
- **`stop`** — graceful first: read the pid, send a `shutdown` control message, await the connection
  CLOSING (the daemon closes its listener → unlink → dispose → exit) — the close IS the confirmation,
  no pidfile race. Closed → "daemon stopped (socket released, pid X)". Did not close within the
  deadline (WEDGED) → **escalate to a pidfile-targeted force-kill** (`force-recover.ts`, t-000051):
  read the kill-target-hint pidfile the daemon dropped at bind, guard it (its `socket` == the managed
  socket, the pid is alive, re-read the pid unchanged before BOTH signals — the anti-recycle guard),
  then SIGTERM→(grace)→SIGKILL and confirm gone → "daemon was wedged — force-killed pid X" (NOT
  "socket released": a SIGKILLed daemon can't unlink its own socket, so the stale file lingers until
  the next `connectOrSpawnDaemon` re-probe clears it). A SIGKILL that does not confirm within the
  budget, or no trustworthy pidfile hint → honest "kill it: kill -9 X" / "kill X" fallback. No daemon
  → "none running".
- **`restart`** — `stop` then `start`. Any **successful** `stop` (graceful, or force-killed, or the
  daemon was already gone / already recovered by another actor — every code-0 outcome) proceeds to
  `start`, which respawns through `connectOrSpawnDaemon` (the same race-safe bind-or-connect
  convergence — never a bespoke unlink-then-spawn; its re-probe also clears the killed daemon's stale
  socket). Only if `stop` could NOT reap the daemon (force-kill unconfirmed / no hint) does it refuse
  to start (a new daemon can't bind while the old holds the socket → `EADDRINUSE`) and tell the user
  to kill the pid first. The "pick up new code" command.

The pidfile (`<socket>.pid`, `support/pidfile/`) is a **kill-target HINT only** — the socket is the
sole liveness oracle (§3.5). It is written AFTER a successful bind (a bind-race loser leaves none)
and removed on graceful shutdown, so a lingering pidfile marks a daemon that never exited cleanly.
The kill escalation never unlinks the socket itself — that stays `connectOrSpawnDaemon`'s job (whose
re-probe is what keeps a sibling's freshly-bound daemon from being unlinked).

`stop`/`restart` forcibly disconnect any live bridges (a kill of the shared daemon), so both emit a
"connected MCP clients must reconnect" note.

## 3. Protocol extension (`daemon/protocol.ts`, zod both directions)

- request `daemon-info` `{id, kind}` — NO `cwd`: deliberately not routed through `status`, whose
  `orchestrator.status(cwd)` warms an engine as a side effect. `daemon-info` is a pure read of the
  daemon's own facts.
- reply `daemon-info` `{id, kind, sourceStale, info:{pid, uptimeMs, engines, engineRoots}}`.
- request `shutdown` `{id, kind}` — NO reply: the confirmation is the connection closing.

`daemonInfo()` lives on a narrow `ServingOrchestrator` (= `OrchestratorApi & { daemonInfo() }`)
implemented by the in-process `Orchestrator` the daemon hosts — NOT on the shared `OrchestratorApi`,
so the bridge's `RemoteOrchestrator` is not forced to fake daemon-process facts (a latent lie).

## 4. Never-hang (§1)

The hang risk is NOT `connect()` (it fails fast on ENOENT/ECONNREFUSED) but a daemon that accepts
the connection and never replies (a wedged accept loop). So every await is deadline-bounded —
await-REPLY for `daemon-info`, await-CLOSE for `stop`, and the force-recover kill ladder (SIGTERM
grace + SIGKILL-confirm poll, each budgeted) — and on overrun the verb reports an honest failure
("unresponsive" / force-kill result / "kill the pid"), never spins. `force-recover` holds the event
loop open with a REF'd keep-alive across its poll (the real `Clock`'s timers are `unref`ed, and the
wedged connection is already closed by then — without it Node would exit 0 mid-wait and abandon the
SIGKILL). A pre-this-version daemon on the same socket rejects the new kinds (its zod is stricter) →
an ERROR reply, mapped to an honest "speaks an older protocol — restart", never a misreport or a throw.

## 5. Tests (§16 — independent oracles; determinism via injectable clock + socket-dir seam)

- **One real-socket smoke** (the happy lifecycle): start → status:running → stop → status:none →
  restart → status:running, over a real unix socket in a tmp socket-dir.
- **No-hang honest-failure** (deterministic): a fake in-memory transport whose connection never
  fires `onMessage`; advance the manual clock past the deadline; assert `status`/`stop` return the
  honest "unresponsive / kill pid" lines, never hang. This is the NO-HANG-critical path the happy
  smoke can't reach.
- **Per-verb units** on an injected in-process daemon: already-running, none-running, restart
  refuses-to-start when stop is wedged, old-daemon error-reply mapping.
- **Force-recover units** (`force-recover.test.ts`, injected liveness/signal/pidfile seams + manual
  clock): the guard branches (no hint / socket-mismatch → no-target; already-gone; re-read pid change
  → target-changed → never signals) and the SIGTERM→SIGKILL escalation (killed / still-alive), each
  bounded. **Mapping units** in `daemon-manage.test.ts` (injected `forceRecover`): each outcome →
  correct verb code/lines; restart proceeds after a force-kill.
- **SIGSTOP real-spawn smoke** (`wedged-daemon-recovery.test.ts`): a real spawned daemon frozen with
  SIGSTOP (the true accepts-but-never-replies wedge, no production test hooks) — `daemon restart`
  force-kills it (old pid provably gone) and binds a fresh one (new pid answers). This is what caught
  the unref'd-timer event-loop-exit bug the fake-clock units cannot.
- **Protocol zod round-trip** for the new `daemon-info` / `shutdown` envelopes.
