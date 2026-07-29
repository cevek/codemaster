// "What is at the socket right now?" for the daemon management verbs (spec-daemon-cli) — the one
// question `tryConnect` cannot answer. A daemon committed to exit still ACCEPTS: the kernel
// completes a connect into its backlog until the listener closes, and it then answers the teardown
// refusal or simply drops the link. So connectivity is not service, and reading the daemon being
// replaced as a live one is what makes `start` skip its spawn and `restart` report success with
// nothing running (§3.6).
//
// Split out of `manage.ts` so its verb logic stays under the line cap. It depends on a NARROW
// `ProbeDeps` rather than the verbs' `DaemonManageDeps`: the probe needs a transport and a clock,
// nothing about killing or spawning — and the narrower dependency is also what keeps the two
// modules a one-way edge instead of a cycle.

import type { Clock } from '../common/async/clock.ts';
import type { Transport, TransportConnection } from '../support/transport/seam.ts';
import type { DaemonInfo } from './orchestrator-api.ts';
import { tryConnect } from './connect-or-spawn.ts';
import { SHUTTING_DOWN_CODE } from './protocol.ts';
import { awaitReply, daemonInfoEnvelope } from './manage-io.ts';

export interface ProbeDeps {
  transport: Transport;
  clock: Clock;
  /** Bounded await-reply deadline for `daemon-info` (ms). Default 5000. */
  replyDeadlineMs?: number;
  /** Bounded wait for a DRAINING daemon to release the socket (ms). Default 5000. */
  releaseTimeoutMs?: number;
}

const DEFAULT_REPLY_MS = 5000;
const DEFAULT_RELEASE_MS = 5000;
const RELEASE_POLL_MS = 50;

export const replyMs = (d: ProbeDeps): number => d.replyDeadlineMs ?? DEFAULT_REPLY_MS;
export const releaseMs = (d: ProbeDeps): number => d.releaseTimeoutMs ?? DEFAULT_RELEASE_MS;

/** What is at the socket right now, as a SERVING verdict — never "did connect succeed".
 *  `draining` is a state to WAIT OUT, not a daemon. */
export type Probe =
  | { kind: 'serving'; info: DaemonInfo }
  | { kind: 'legacy' } // answered, but rejects daemon-info (pre-this-version code)
  | { kind: 'wedged' } // accepted, still open, no reply within the deadline
  | { kind: 'draining' } // accepted, but tearing down (refusal reply, or the link dropped)
  | { kind: 'none' }; // nothing at the socket

export async function probeDaemon(deps: ProbeDeps): Promise<Probe> {
  const conn = await tryConnect(deps.transport);
  if (conn === undefined) return { kind: 'none' };
  try {
    const info = await fetchInfo(conn, deps);
    switch (info.kind) {
      case 'ok':
        return { kind: 'serving', info: info.info };
      case 'unsupported':
        return { kind: 'legacy' };
      case 'timeout':
        return { kind: 'wedged' };
      case 'shutting-down':
      case 'closed':
        return { kind: 'draining' };
    }
  } finally {
    await conn.close();
  }
}

/** Probe until the answer is not `draining`, bounded (§1). A daemon that has committed to exit
 *  still holds the socket for a beat, and a daemon spawned into a held socket loses the bind race
 *  and exits — silently, since the spawn is fire-and-forget. So `start` waits for the release
 *  rather than racing it, and says so honestly if the wait runs out. */
export async function awaitRelease(deps: ProbeDeps): Promise<Probe> {
  const deadline = deps.clock.now() + releaseMs(deps);
  for (;;) {
    const probe = await probeDaemon(deps);
    if (probe.kind !== 'draining' || deps.clock.now() >= deadline) return probe;
    await new Promise<void>((resolve) => {
      deps.clock.schedule(RELEASE_POLL_MS, resolve);
    });
  }
}

export type InfoOutcome =
  | { kind: 'ok'; info: DaemonInfo; sourceStale: boolean }
  | { kind: 'timeout' }
  | { kind: 'closed' }
  | { kind: 'shutting-down' }
  | { kind: 'unsupported'; message: string };

/** Send one `daemon-info` request and await its reply, deadline-bounded. An error reply (an old
 *  daemon that doesn't know the kind) maps to `unsupported`, never a throw — EXCEPT the one error a
 *  current daemon deliberately sends: a connect that lands after teardown began is answered with the
 *  `SHUTTING_DOWN_CODE` refusal, and reading that as "old code" would print a confident, wrong
 *  diagnosis (§3.6). Branch on the code, never the prose. */
export async function fetchInfo(conn: TransportConnection, deps: ProbeDeps): Promise<InfoOutcome> {
  const id = 1;
  const outcome = await awaitReply(conn, deps.clock, daemonInfoEnvelope(id), id, replyMs(deps));
  if (outcome.kind === 'timeout') return { kind: 'timeout' };
  // The link closed before answering — a daemon on its way out, NOT one that is merely slow. The
  // two carry opposite remedies (wait for it to go vs. recover a wedge), so they stay distinct.
  if (outcome.kind === 'closed') return { kind: 'closed' };
  const reply = outcome.reply;
  if (reply.kind === 'daemon-info')
    return { kind: 'ok', info: reply.info, sourceStale: reply.sourceStale };
  if (reply.kind === 'error') {
    if (reply.message.startsWith(SHUTTING_DOWN_CODE)) return { kind: 'shutting-down' };
    return { kind: 'unsupported', message: reply.message };
  }
  return { kind: 'unsupported', message: `unexpected reply kind ${reply.kind}` };
}

export const describe = (o: InfoOutcome): string =>
  o.kind === 'timeout'
    ? 'unresponsive'
    : o.kind === 'closed'
      ? 'closed the connection without replying'
      : o.kind === 'shutting-down'
        ? 'shutting down'
        : o.kind === 'unsupported'
          ? 'speaks an older protocol'
          : 'ok';
