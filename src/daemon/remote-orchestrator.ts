// The bridge's view of the daemon (spec-daemon-singleton §2). A thin `OrchestratorApi` forwarder:
// it serializes each request to an NDJSON envelope over the socket connection, matches the reply by
// id, and renders nothing itself (the bridge's `serveMcp` does). It holds NO project state.
//
// Never-hang (§1): every request is bounded by a reply deadline → an honest failure ("daemon did
// not reply — fall back"), never an unbounded wait. A dropped connection fails all in-flight
// requests at once. `sourceStale` rides the daemon's spawn fingerprint, cached from each reply
// envelope (the banner reflects the DAEMON's code age, not the bridge's — §3.6 / spec §3).
//
// Wedge probe (t-000051): on a reply-timeout the bridge fires ONE short-deadline `daemon-info`
// liveness ping (a pure read that touches no engine) to tell "busy/slow" from "front door
// UNRESPONSIVE". Any reply — even an error — proves the front door services requests (busy/slow);
// only a second timeout (or a closed link) is unresponsive, which enriches the honest failure with a
// `codemaster daemon restart` steer. The bridge NEVER auto-kills (that is B2, deferred t-783490); a
// SINGLE-listener transport means the probe reuses this same pending/onMessage machinery, not a
// second handler. "unresponsive", not "wedged": in the default in-process mode a genuinely busy
// daemon can't answer either, so the signal is ambiguous by construction and stated as such.

import type { Clock, CancelTimer } from '../common/async/clock.ts';
import type { JsonValue } from '../core/json.ts';
import type { BatchOptions, OpRequest, OpResult } from '../ops/contracts.ts';
import type { StatusView } from '../format/render/render-status.ts';
import type { TransportConnection } from '../support/transport/seam.ts';
import type { OrchestratorApi } from './orchestrator-api.ts';
import { daemonInfoEnvelope } from './manage-io.ts';
import { parseWireReply, type WireReply } from './protocol.ts';

type RequestOutcome = { ok: true; results: readonly OpResult[] } | { ok: false; message: string };

export interface RemoteOrchestratorDeps {
  connection: TransportConnection;
  clock: Clock;
  /** Per-request reply deadline (ms). On overrun the request fails honestly — the agent falls back. */
  replyDeadlineMs: number;
  /** Short deadline for the post-timeout `daemon-info` liveness ping (ms). Default 5000. */
  probeDeadlineMs?: number;
  /** The bridge's version — used to synthesize a degraded `status` view on a daemon failure. */
  version: string;
}

/** STABLE MACHINE SENTINEL for a locally-synthesized "the link is gone" reply. `probeLiveness`
 *  branches on this prefix, never on the prose after it: the message is agent-facing text and the
 *  docs rule invites rewording it, which — compared whole — would silently disable
 *  unresponsive-daemon detection. Keep the code even if every word after it changes. */
const CLOSED_CODE = 'daemon-link-closed';

/** What the bridge can honestly say when the link drops mid-call: the socket closed. It CANNOT say
 *  why — it outlived the daemon, and from here a fatal and a clean exit look identical (the pidfile
 *  is a kill-target hint, never a liveness oracle, §3.5), so asserting a crash would be the
 *  fabricated-fatal lie `support/usage-log/inflight.ts` exists to prevent. It points at where the
 *  discriminator lives instead — the daemon's own in-flight breadcrumb (t-305430) — and is explicit
 *  that ABSENCE proves nothing: reconciliation only runs at a later codemaster start, so a real
 *  fatal reads as absent until then. No path is quoted: the usage dir is relocatable
 *  (`CODEMASTER_USAGE_DIR`), so a literal `~/.codemaster/...` would point some readers at the wrong
 *  file. */
const CLOSED_MESSAGE = `${CLOSED_CODE}: connection closed mid-call — this side cannot tell a fatal from a clean exit; a fatal surfaces in the usage log as outcome:"crash" origin:"daemon" once a later codemaster start reconciles it (absence is not proof of a clean exit)`;

/** The link was ALREADY closed when the request was handed over, so nothing was ever sent — no
 *  daemon-side breadcrumb can exist for it, and steering the reader to look for one would send them
 *  after a record that provably cannot be written. */
const NEVER_SENT_MESSAGE = `${CLOSED_CODE}: connection already closed — this request was never sent to the daemon; reconnect and retry`;
const DEFAULT_PROBE_DEADLINE_MS = 5000;

export function createRemoteOrchestrator(deps: RemoteOrchestratorDeps): OrchestratorApi {
  let nextId = 1;
  let sourceStaleCache = false;
  let closed = false;
  const pending = new Map<number, (reply: WireReply) => void>();

  deps.connection.onClose(() => {
    closed = true;
    for (const [id, resolve] of pending) {
      resolve({ id, kind: 'error', message: CLOSED_MESSAGE });
    }
    pending.clear();
  });
  deps.connection.onMessage((raw) => {
    const parsed = parseWireReply(raw);
    if (!parsed.ok) {
      // Corrupt reply — fail the correlated request if we can recover its id, else let the
      // deadline catch it. Never throw into the transport.
      const id = idOf(raw);
      pending.get(id)?.({ id, kind: 'error', message: `corrupt reply: ${parsed.error}` });
      pending.delete(id);
      return;
    }
    const reply = parsed.value;
    if (reply.kind !== 'error') sourceStaleCache = reply.sourceStale;
    const resolve = pending.get(reply.id);
    if (resolve !== undefined) {
      pending.delete(reply.id);
      resolve(reply);
    }
  });

  // Outcome-based so a deadline overrun is DISTINGUISHABLE from a real error reply — the wedge probe
  // needs that difference (a real error still proves the front door is live).
  function sendAndAwait(
    envelope: JsonValue,
    id: number,
    deadlineMs: number,
  ): Promise<AwaitOutcome> {
    if (closed)
      return Promise.resolve({
        kind: 'reply',
        reply: { id, kind: 'error', message: NEVER_SENT_MESSAGE },
      });
    return new Promise<AwaitOutcome>((resolve) => {
      let cancelTimer: CancelTimer = () => undefined;
      const settle = (o: AwaitOutcome): void => {
        cancelTimer();
        pending.delete(id);
        resolve(o);
      };
      pending.set(id, (reply) => settle({ kind: 'reply', reply }));
      cancelTimer = deps.clock.schedule(deadlineMs, () => settle({ kind: 'timeout' }));
      deps.connection.send(envelope);
    });
  }

  /** One short-deadline `daemon-info` ping. Any reply — even an old daemon's error — proves the
   *  front door services requests; only a timeout or a closed link means unresponsive. */
  async function probeLiveness(): Promise<'alive' | 'unresponsive'> {
    if (closed) return 'unresponsive';
    const id = nextId++;
    const out = await sendAndAwait(
      daemonInfoEnvelope(id),
      id,
      deps.probeDeadlineMs ?? DEFAULT_PROBE_DEADLINE_MS,
    );
    if (out.kind === 'timeout') return 'unresponsive';
    // Prefix, not equality: any locally-synthesized closed-link reply means the front door is gone,
    // and the branch must survive a reword of either message (see CLOSED_CODE).
    if (out.reply.kind === 'error' && out.reply.message.startsWith(CLOSED_CODE))
      return 'unresponsive';
    return 'alive';
  }

  /** The honest failure message for a reply-timeout, enriched by the liveness probe. */
  async function wedgeMessage(): Promise<string> {
    const base = `daemon did not reply in ${deps.replyDeadlineMs}ms`;
    return (await probeLiveness()) === 'alive'
      ? `${base} — daemon is busy/slow (still responsive); falling back — retry shortly`
      : `${base} and its front door is UNRESPONSIVE — run \`codemaster daemon restart\` then reconnect; falling back`;
  }

  return {
    async request(cwd, root, reqs, batch) {
      const id = nextId++;
      const out = await sendAndAwait(
        wireRequest(id, cwd, root, reqs, batch),
        id,
        deps.replyDeadlineMs,
      );
      if (out.kind === 'timeout') return { ok: false, message: await wedgeMessage() };
      const reply = out.reply;
      if (reply.kind === 'error') return { ok: false, message: reply.message };
      if (reply.kind === 'request') return reply.outcome as RequestOutcome;
      return { ok: false, message: 'unexpected reply kind for request' };
    },
    async status(cwd, root) {
      const id = nextId++;
      const out = await sendAndAwait(statusRequest(id, cwd, root), id, deps.replyDeadlineMs);
      if (out.kind === 'reply' && out.reply.kind === 'status') return out.reply.view;
      const message =
        out.kind === 'timeout'
          ? await wedgeMessage()
          : out.reply.kind === 'error'
            ? out.reply.message
            : 'unexpected reply kind for status';
      return degradedStatus(deps.version, sourceStaleCache, message);
    },
    sourceStale: () => sourceStaleCache,
    dispose: () => deps.connection.close(),
  };
}

type AwaitOutcome = { kind: 'reply'; reply: WireReply } | { kind: 'timeout' };

function wireRequest(
  id: number,
  cwd: string,
  root: string | undefined,
  reqs: readonly OpRequest[],
  batch: BatchOptions | undefined,
): JsonValue {
  const env = {
    id,
    kind: 'request',
    cwd,
    reqs,
    ...(root !== undefined ? { root } : {}),
    ...(batch !== undefined ? { batch } : {}),
  };
  return env as unknown as JsonValue;
}

function statusRequest(id: number, cwd: string, root: string | undefined): JsonValue {
  return {
    id,
    kind: 'status',
    cwd,
    ...(root !== undefined ? { root } : {}),
  } as unknown as JsonValue;
}

/** A failed `status` still returns a StatusView — the failure surfaces in `workspaceError`, never a
 *  thrown call (the OrchestratorApi.status contract has no failure channel). */
function degradedStatus(version: string, sourceStale: boolean, error: string): StatusView {
  return {
    daemonVersion: version,
    pid: process.pid,
    isolation: 'in-process',
    engines: 0,
    engineRoots: [],
    workspace: undefined,
    workspaceError: `daemon unreachable: ${error}`,
    debugTopics: [],
    sourceStale,
  };
}

function idOf(raw: JsonValue): number {
  if (typeof raw === 'object' && raw !== null && !Array.isArray(raw)) {
    const id = (raw as { [k: string]: JsonValue })['id'];
    if (typeof id === 'number') return id;
  }
  return -1;
}
