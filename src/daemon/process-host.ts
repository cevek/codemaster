// The `process`-mode `ProjectHost` (§2/§9): the parent side of the fork. Marshals request /
// produceSql / status / dispose to the engine child over IPC and — the keystone — never hangs on a
// wedged child: every request is deadline-bounded, and on overrun the child is SIGKILLed (a wedged
// sync TS program build can't be cancelled otherwise, §19) and every pending request settles
// honestly. A crash / OOM likewise settles all pending with an honest `ToolFailure` and evicts the
// slot so the next request respawns — the daemon stays up (t-167395). Pending discipline mirrors
// remote-orchestrator.ts (cancel-on-settle, delete-before-resolve, no double-settle): a per-request
// timer only TRIPS the kill; `markDead` (the child's single `exit`) settles every pending id once.

import type { Clock, CancelTimer } from '../common/async/clock.ts';
import type { JsonValue } from '../core/json.ts';
import type { RepoId } from '../core/brands.ts';
import type { OpRequest, OpResult } from '../ops/contracts.ts';
import { fail } from '../common/result/construct.ts';
import type { ProjectHost } from './host.ts';
import type { EngineChildHandle } from './fork-engine.ts';
import { parseEngineFrame, type EngineReply, type EngineRequest } from './engine-protocol.ts';

export interface ProcessHostDeps {
  repoId: RepoId;
  clock: Clock;
  /** Fork (or fake) the engine child. Called once per host; a respawn is a NEW host. */
  spawn: () => EngineChildHandle;
  /** Bound on the child's build+ready handshake. On overrun the spawn fails honestly. */
  startupDeadlineMs: number;
  /** Per-request reply deadline (§1). Generous — a cold warm+heavy op is fine — but bounded so a
   *  wedged child yields an honest failure, never an unbounded wait. */
  requestDeadlineMs: number;
  /** Grace before a dispose SIGTERM escalates to SIGKILL. */
  disposeDeadlineMs: number;
  /** Called once when the child is gone (crash / OOM / dispose / timeout-kill) so the
   *  orchestrator evicts the slot and the next request respawns. */
  onExit: () => void;
}

type DeadReason = 'crash' | 'oom' | 'timeout';
type Settled = { ok: true; reply: EngineReply } | { ok: false; reason: DeadReason; detail: string };

/** OOM is best-effort: V8's heap-OOM aborts as SIGABRT / code 134 on most platforms, but the
 *  signature is not portable, so we only HINT `oom` when it matches — never assert it on an
 *  ambiguous exit (that would be its own small lie). */
function isOom(code: number | null, signal: string | null): boolean {
  return code === 134 || signal === 'SIGABRT';
}

export async function createProcessHost(
  deps: ProcessHostDeps,
): Promise<{ ok: true; host: ProjectHost } | { ok: false; message: string }> {
  const child = deps.spawn();
  const pending = new Map<number, { settle: (s: Settled) => void; cancel: CancelTimer }>();
  const disposeWaiters: Array<() => void> = [];
  let nextId = 1;
  let dead = false;
  let deadlineTripped = false;
  let onStartup: ((r: { ok: true } | { ok: false; message: string }) => void) | undefined;

  const markDead = (code: number | null, signal: string | null): void => {
    if (dead) return;
    dead = true;
    const reason: DeadReason = deadlineTripped ? 'timeout' : isOom(code, signal) ? 'oom' : 'crash';
    const detail = `code=${String(code)} signal=${String(signal)}`;
    for (const [, p] of pending) {
      p.cancel();
      p.settle({ ok: false, reason, detail });
    }
    pending.clear();
    onStartup?.({ ok: false, message: `engine child exited during startup (${detail})` });
    for (const w of disposeWaiters.splice(0)) w();
    deps.onExit();
  };

  child.onExit((code, signal) => markDead(code, signal));
  child.onMessage((raw) => {
    const parsed = parseEngineFrame(raw);
    if (!parsed.ok) return; // corrupt frame — the request's deadline / the exit handler settles it
    const frame = parsed.value;
    if (!('id' in frame)) {
      onStartup?.(frame.kind === 'ready' ? { ok: true } : { ok: false, message: frame.message });
      return;
    }
    const p = pending.get(frame.id);
    if (p !== undefined) {
      p.cancel();
      pending.delete(frame.id);
      p.settle({ ok: true, reply: frame });
    }
  });

  // Startup handshake: resolve on the child's `ready` / `fatal`, its death, or the deadline.
  const started = await new Promise<{ ok: true } | { ok: false; message: string }>((resolve) => {
    const cancel = deps.clock.schedule(deps.startupDeadlineMs, () =>
      finish({ ok: false, message: `engine child did not start in ${deps.startupDeadlineMs}ms` }),
    );
    let done = false;
    const finish = (r: { ok: true } | { ok: false; message: string }): void => {
      if (done) return;
      done = true;
      onStartup = undefined;
      cancel();
      resolve(r);
    };
    onStartup = finish;
  });
  if (!started.ok) {
    child.kill('SIGKILL');
    return { ok: false, message: started.message };
  }

  function sendAndAwait(envelope: EngineRequest): Promise<Settled> {
    if (dead) {
      return Promise.resolve<Settled>({
        ok: false,
        reason: 'crash',
        detail: 'child already exited',
      });
    }
    return new Promise<Settled>((resolve) => {
      const id = envelope.id;
      const cancel = deps.clock.schedule(deps.requestDeadlineMs, () => {
        // A wedged child can't be cancelled cooperatively (§19) — kill it; `markDead` (on the
        // child's exit) settles THIS and every other pending id as `timeout`.
        deadlineTripped = true;
        child.kill('SIGKILL');
      });
      pending.set(id, { settle: resolve, cancel });
      child.send(envelope as unknown as JsonValue);
    });
  }

  function failAll(reqs: readonly OpRequest[], s: Extract<Settled, { ok: false }>): OpResult[] {
    const tool = s.reason === 'timeout' ? 'timeout' : s.reason === 'oom' ? 'oom' : 'engine-process';
    const message =
      s.reason === 'timeout'
        ? `isolated engine did not reply in ${deps.requestDeadlineMs}ms — killed it; fall back`
        : `isolated engine process ${s.reason === 'oom' ? 'ran out of memory' : 'exited'} (${s.detail}) — fall back`;
    return reqs.map((r) => ({
      name: r.name,
      result: fail<JsonValue>({ tool, message, partial: true }),
    }));
  }

  const host: ProjectHost = {
    repoId: deps.repoId,
    isolation: 'process',
    async request(reqs, batch) {
      const out = await sendAndAwait({
        id: nextId++,
        kind: 'request',
        reqs,
        ...(batch !== undefined ? { batch } : {}),
      });
      if (!out.ok) return failAll(reqs, out);
      if (out.reply.kind === 'request') return out.reply.results;
      const message = out.reply.kind === 'error' ? out.reply.message : 'unexpected reply kind';
      return reqs.map((r) => ({
        name: r.name,
        result: fail<JsonValue>({ tool: 'engine-process', message, partial: true }),
      }));
    },
    async produceSql(reqs) {
      const out = await sendAndAwait({ id: nextId++, kind: 'produceSql', reqs });
      if (out.ok && out.reply.kind === 'produceSql')
        return { results: out.reply.results, freshness: out.reply.freshness };
      const bad = fail<JsonValue>({
        tool: 'engine-process',
        message: 'unexpected reply kind',
        partial: true,
      });
      const results = out.ok
        ? reqs.map((r) => ({ name: r.name, result: bad }))
        : failAll(reqs, out);
      return { results, freshness: undefined };
    },
    async status() {
      const out = await sendAndAwait({ id: nextId++, kind: 'status' });
      if (out.ok && out.reply.kind === 'status') return out.reply.view;
      // No honest WorkspaceStatusView to synthesize for a dead/erroring child — surface the
      // failure by rejecting; the orchestrator turns it into a `workspaceError`, never a
      // fabricated 0-plugin manifest (§3.6).
      const detail = out.ok ? 'unexpected reply' : `${out.reason} (${out.detail})`;
      throw new Error(`isolated engine status failed: ${detail}`);
    },
    dispose() {
      if (dead) return Promise.resolve();
      return new Promise<void>((resolve) => {
        disposeWaiters.push(resolve);
        // Ask the child to dispose+exit; escalate to SIGKILL if it doesn't leave in time.
        child.send({ id: nextId++, kind: 'dispose' } as unknown as JsonValue);
        deps.clock.schedule(deps.disposeDeadlineMs, () => {
          if (!dead) child.kill('SIGKILL');
        });
      });
    },
  };
  return { ok: true, host };
}
