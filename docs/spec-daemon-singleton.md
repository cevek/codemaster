# Spec: one warm daemon — singleton orchestrator + orphan-free MCP servers

Status: **proposed**. Formalizes the deferred [plan.md](plan.md) Phase-0 item
_"`daemon/` IPC server (newline-delimited JSON) + daemon singleton (bind-or-connect)"_
and the orphan-reaping it implies. Realizes the process topology ARCHITECTURE.md §2 and
the §19 "daemon singleton" decision already describe as the design — but which the code
does **not** yet implement. Touches `bin.ts` (`mcp` command), a new `daemon/transport/`
seam, and `mcp/server.ts`. Independent of the plugin work; can land any time after Phase 0.

## 1. Problem & evidence

ARCHITECTURE.md §2 promises **one** long-lived front-door process that "amortizes the
expensive warm state (the `ts` plugin's LS chiefly) across every agent call in a session"
and "serves many agents across many workspaces." §19 specifies the convergence mechanism
(atomic bind-or-connect on a socket, stale-socket recovery). **Neither is implemented.**

Today (`src/bin.ts` `case 'mcp'`): `buildOrchestrator()` constructs a fresh **in-process**
`Orchestrator` (registry + engines + warm LS) inside the process, and `serveMcp` exposes it
over a **`StdioServerTransport`**. There is no socket, no lockfile, no bind-or-connect (grep:
no `listen(`/`EADDRINUSE`/lockfile anywhere). An MCP-over-stdio server is, by protocol, **one
child process per client connection** — so every Claude session / editor window / **worktree**
that connects spawns its own orchestrator with its own multi-GB LS, sharing nothing.

Two distinct failures result:

1. **No amortization (the §2 promise is false today).** N concurrent connections = N cold
   starts + N independent warm LSes. On a large repo that is N × gigabytes — exactly the
   OOM risk §9 exists to bound, multiplied by connection count.
2. **Orphan accumulation.** Observed in the field: **26** live `node bin.ts mcp` processes.
   `serveMcp` _does_ wire clean shutdown (`stdin.on('end')` → dispose+exit, `server.onclose`,
   SIGTERM/SIGINT). It fails to fire when the **in-process event loop is blocked by a heavy
   synchronous LS call** (in-process mode "blocks the shared loop", §2) so a queued stdin-EOF
   is never processed; or when the parent is `SIGKILL`ed without cleanly closing the pipe; or
   when the stdin write-end leaks to another process so EOF never arrives. A blocked or
   missed-EOF server has **no idle deadline**, so it lives forever. The worktree-spam workflow
   (§8/§9/§18) drives the connection count, and orphans pile up across sessions.

The honesty cost: §2/§19 currently **assert the singleton as existing**. That is doc-drift
(a claim the code contradicts) and must be reconciled (§8 below).

## 2. The model — singleton daemon + thin stdio bridge

Split the one fat per-connection process into **two roles**, exactly as §2's "front door vs
engine" seam already implies:

- **The daemon** — one long-lived process per machine (per user). Holds the `repoId → engine`
  registry, the warm LS(es), lifecycle (idle-TTL / path-existence / governor — §9, unchanged),
  and listens on a **unix socket** speaking newline-delimited JSON (§18). It only routes; heavy
  work lives in the engines it owns (in-process for now; the §2 `process`-mode child split is a
  **separate** roadmap item, not this spec).
- **The bridge** — what `codemaster mcp` becomes: a **dumb** stdio↔socket proxy. It speaks MCP
  over stdio to the client and forwards each request to the daemon over the socket, streaming the
  reply back. It holds **no project state and does no heavy work**, so its event loop is never
  blocked — `stdin 'end'` is always processed promptly. One bridge per client connection (cheap);
  one daemon shared by all bridges.

**Convergence (§19, atomic bind-or-connect).** On `mcp` start the bridge tries to **connect** to
the socket; on `ENOENT`/`ECONNREFUSED` (no daemon, or a stale socket file) it performs a liveness
probe, `unlink`s a stale socket, and **binds** — becoming (or spawning) the daemon. A concurrent
launch racing on `EADDRINUSE` loses and connects to the winner. Net: exactly one daemon, every
bridge converges on it.

**Socket path (§19).** A short, hashed path under the user runtime dir (or `os.tmpdir()`),
length-asserted at bind to stay under `sun_path`'s ~104/108-byte limit. A `Transport` seam
(mirroring `ProjectHost`, §2) so a Windows named-pipe impl drops in later (§4).

## 3. Lifecycle & orphan-freedom (this is what kills the 26)

- **Bridge exits on client disconnect, always.** Because the bridge does no heavy work, a blocked
  loop can never swallow `stdin 'end'`. On EOF / socket error it exits immediately. A dead bridge
  never touches the daemon's warm state.
- **Daemon idle self-exit — a hard deadline, not EOF-dependent.** The daemon exits after
  `daemon.idleEvictionMinutes` with **zero open bridge connections and no in-flight requests**,
  then `unlink`s its socket. This is the belt-and-suspenders that makes an immortal orphan
  impossible: even if every disconnect signal were missed, the idle timer (its own loop is free
  when idle) terminates it. Next `mcp` start respawns it (cheap, lazy — §9).
- **Engine eviction unchanged but now shared.** Idle-TTL eviction, the path-existence sweeper, and
  the memory governor (§9) run **once** in the daemon over the shared engine set — so worktree
  churn evicts engines centrally instead of leaking a whole orchestrator per worktree.
- **Stale-socket recovery (§19).** A `SIGKILL`ed daemon leaves a dangling socket file; the next
  bridge's connect fails, it probes liveness, `unlink`s, and rebinds — no hang, no manual cleanup.
- **Self-staleness banner preserved.** The `src/**` fingerprint that drives the "reconnect MCP"
  banner (spec-status-as-the-doc, §3.6) is taken at **daemon** spawn; reconnecting a bridge does
  not refresh it (the daemon is the long-lived code) — so the banner still tells the agent when the
  daemon predates an edit. The daemon's own idle-exit naturally clears stale code over time.

## 4. Transport seam

A `Transport` interface (`listen`/`connect`/`send`/`onMessage`/`close`) with a unix-socket impl
now and a named-pipe impl later, mirroring the `ProjectHost` two-impl pattern (§2). The daemon and
bridge both speak `Transport`, never a concrete socket — flipping platforms never touches
orchestrator code.

## 5. The CLI one-shot path stays one-shot (do NOT route it through the daemon)

`codemaster op …` / `codemaster status` are **deliberately** fresh short-lived processes that build
an in-process orchestrator, answer, and exit — the self-dev loop (CONTRIBUTING "Self-dev loop")
relies on each invocation reflecting the **current source** with no daemon to reconnect. Only the
long-lived `mcp` command joins the socket daemon. Keep `buildOrchestrator()` usable inline for
(a) the CLI one-shot, (b) tests, (c) an explicit `--in-process` escape hatch for debugging the
daemon without the socket. The socket daemon is a `mcp`-only concern.

## 6. Staging (each independently shippable)

- **Stage 1 — stop the bleeding (orphan-reaping on today's model), small.** Without the
  bridge/daemon split: add the **idle self-exit hard deadline** to `serveMcp` (a timer armed
  between requests; on idle with no in-flight request → dispose + `exit(0)`). This bounds orphan
  lifetime to the TTL even when stdin-EOF is missed. Does **not** fix amortization (still N warm
  LSes for N concurrent clients) — but it ends the unbounded pile-up immediately and is a few lines.
- **Stage 2 — the singleton (amortization + convergence), the real fix.** The §2–§4 daemon + bridge
  split. Delivers the warm-state sharing §2 promises and subsumes Stage 1's idle-exit at the daemon
  level.

Stage 1 is worth landing first: the 26 are dominated by orphans from sequential worktree churn, which
Stage 1 alone collapses to at-most-one-per-active-client.

## 7. Tests (§16 — independent oracles; determinism via injectable clock + a socket-dir seam)

| Claim                                                                        | Oracle                                                                                                                                             |
| ---------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| two concurrent `mcp` bridges → exactly ONE daemon bound                      | spawn two bridges at one socket dir; assert one listener / one daemon pid; both get correct `status` replies                                       |
| a bridge whose client closes stdin exits; the daemon + other bridges survive | close one bridge's stdin; assert it exits, the daemon stays up, a second bridge still answers                                                      |
| daemon idle self-exit + socket unlink after TTL                              | drive the injected clock past `idleEvictionMinutes` with no connections; assert daemon exits and the socket file is gone; a new bridge respawns it |
| Stage 1: a `serveMcp` server idle-exits even if stdin-EOF never arrives      | hold stdin open, advance the injected clock past TTL; assert `exit(0)`                                                                             |
| stale socket (daemon `SIGKILL`ed) → next bridge unlinks + rebinds, no hang   | leave a dangling socket file; assert the next `mcp` start binds within the deadline, never spins                                                   |
| convergence race                                                             | two bridges binding simultaneously → one wins, the loser connects (no crash, no double-bind)                                                       |
| CLI one-shot does NOT spawn/keep a daemon                                    | `op`/`status` from the CLI leaves no socket and no lingering process (one-shot reflects current source)                                            |
| self-staleness banner rides the daemon's spawn fingerprint, not the bridge's | edit `src/**`, reconnect only the bridge → banner still fires until the daemon idle-exits/respawns                                                 |

No `sleep` in any of these — drive the injected `Clock` and a socket-dir seam (mirroring the watcher
seam, §16). One real-socket smoke test, like the chokidar smoke test.

## 8. Doc reconciliation (do this WITH the code, never lie in the interim)

- ARCHITECTURE.md §2 and §19 describe the singleton/bind-or-connect as the design. Until Stage 2
  ships they overstate the present — add a one-line "**roadmap, not yet implemented; today each
  `mcp` connection hosts its own in-process orchestrator (spec-daemon-singleton)**" to both, and
  flip them to present-tense when it lands.
- plan.md's deferred bullet (`daemon singleton (bind-or-connect)`) points here; check its box per
  stage.

## 9. Non-goals

- **`process`-mode engine isolation** (one child process per workspace, §2/§9) — orthogonal; this
  spec shares ONE in-process orchestrator across bridges. Per-workspace process isolation is its own
  roadmap item and composes on top (the daemon would own the child engines).
- **Windows named pipe in v1** — seam only (§4); unix socket ships first.
- **Cross-machine / networked daemon** — local socket only; the inbox-style "never leaves the
  machine" stance holds.
- **Persisting warm state across daemon restarts** — still cold-start on respawn (§8/§18 disk-snapshot
  rationale unchanged).
