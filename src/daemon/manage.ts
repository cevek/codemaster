// User-facing daemon management verbs (spec-daemon-cli): `codemaster daemon start|stop|restart|
// status`. The singleton daemon (spec-daemon-singleton) is otherwise reaped only by idle-TTL and
// has no control surface (just `pkill`); these verbs give the agent honest start/stop/restart and a
// live status probe, and `restart` is the "pick up new code" command (kill the stale-code daemon →
// the next bridge spawns a fresh one on current source).
//
// Never-hang (§1): the hang risk is NOT `connect()` (it fails fast on ENOENT/ECONNREFUSED) but a
// daemon that accepts the connection and never replies (a wedged accept loop). So every await is
// deadline-bounded — await-REPLY for `daemon-info`, await-CLOSE for `stop` — and on overrun we report
// an honest "unresponsive / kill the pid", never spin. A pre-this-version daemon on the same socket
// rejects the new `daemon-info`/`shutdown` kinds (its zod is stricter) → an ERROR reply, which we map
// to an honest "speaks an older protocol — restart" rather than a misreport.

import type { Clock } from '../common/async/clock.ts';
import type { JsonValue } from '../core/json.ts';
import type { Transport, TransportConnection } from '../support/transport/seam.ts';
import type { DaemonInfo } from './orchestrator-api.ts';
import { connectOrSpawnDaemon, tryConnect } from './connect-or-spawn.ts';
import { parseWireReply, type WireReply } from './protocol.ts';

export interface DaemonManageDeps {
  transport: Transport;
  socketPath: string;
  clock: Clock;
  /** Fire the detached daemon spawn (injectable so tests start an in-process daemon instead). */
  spawnDaemon: () => void;
  /** Bounded await-reply deadline for `daemon-info` (ms). Default 5000. */
  replyDeadlineMs?: number;
  /** Bounded await-close deadline for `stop` (ms). Default 10000. */
  stopTimeoutMs?: number;
  /** Spawn budget forwarded to `connectOrSpawnDaemon` (ms). */
  spawnTimeoutMs?: number;
}

export interface ManageResult {
  /** Process exit code: 0 = success / honest "none running"; 1 = a real failure (unresponsive,
   *  couldn't stop, couldn't start); 2 = bad verb. */
  code: number;
  /** Lines to print to stdout (agent-facing) in order. */
  lines: string[];
}

const DEFAULT_REPLY_MS = 5000;
const DEFAULT_STOP_MS = 10_000;
const replyMs = (d: DaemonManageDeps): number => d.replyDeadlineMs ?? DEFAULT_REPLY_MS;
const stopMs = (d: DaemonManageDeps): number => d.stopTimeoutMs ?? DEFAULT_STOP_MS;

/** Dispatch a management verb. `serve` (the internal long-lived daemon) is NOT here — it needs an
 *  orchestrator and lives in `bin.ts`; these verbs are pure socket clients. */
export async function runDaemonCommand(
  verb: string,
  deps: DaemonManageDeps,
): Promise<ManageResult> {
  switch (verb) {
    case 'status':
      return daemonStatus(deps);
    case 'start':
      return daemonStart(deps);
    case 'stop':
      return daemonStop(deps);
    case 'restart':
      return daemonRestart(deps);
    default:
      return {
        code: 2,
        lines: [`unknown daemon verb '${verb}' — use: status | start | stop | restart`],
      };
  }
}

async function daemonStatus(deps: DaemonManageDeps): Promise<ManageResult> {
  const conn = await tryConnect(deps.transport);
  if (conn === undefined)
    return { code: 0, lines: [`no daemon running (socket: ${deps.socketPath})`] };
  try {
    const info = await fetchInfo(conn, deps);
    if (info.kind === 'timeout')
      return {
        code: 1,
        lines: [
          `daemon running but UNRESPONSIVE (no reply in ${replyMs(deps)}ms) — socket: ${deps.socketPath}`,
          // Match a legacy bare-`daemon` process too (the unresponsive case is often a pre-edit daemon).
          `find the pid: pgrep -f 'codemaster.*daemon'`,
        ],
      };
    if (info.kind === 'unsupported')
      return {
        code: 1,
        lines: [
          `daemon running but does not speak daemon-info (likely pre-restart/old code) — run \`codemaster daemon restart\` or kill the pid; socket: ${deps.socketPath}`,
        ],
      };
    const i = info.info;
    const lines = [
      `daemon running pid=${i.pid} uptime=${fmtUptime(i.uptimeMs)} engines=${i.engines}`,
      `socket: ${deps.socketPath}`,
    ];
    if (i.engineRoots.length > 0) lines.push(`warm roots: ${i.engineRoots.join(' · ')}`);
    if (info.sourceStale)
      lines.push('!! daemon code behind source — run `codemaster daemon restart` to pick up edits');
    return { code: 0, lines };
  } finally {
    await conn.close();
  }
}

async function daemonStart(deps: DaemonManageDeps): Promise<ManageResult> {
  const existing = await tryConnect(deps.transport);
  if (existing !== undefined) {
    try {
      const info = await fetchInfo(existing, deps);
      if (info.kind === 'ok')
        return {
          code: 0,
          lines: [
            `daemon already running (pid=${info.info.pid}, uptime=${fmtUptime(info.info.uptimeMs)})`,
          ],
        };
      return { code: 0, lines: [`daemon already running (info unavailable — ${describe(info)})`] };
    } finally {
      await existing.close();
    }
  }
  const conn = await connectOrSpawnDaemon({
    transport: deps.transport,
    socketPath: deps.socketPath,
    clock: deps.clock,
    spawnDaemon: deps.spawnDaemon,
    ...(deps.spawnTimeoutMs !== undefined ? { spawnTimeoutMs: deps.spawnTimeoutMs } : {}),
  });
  if (conn === undefined)
    return {
      code: 1,
      lines: [`failed to start daemon within the spawn budget — socket: ${deps.socketPath}`],
    };
  try {
    const info = await fetchInfo(conn, deps);
    if (info.kind === 'ok') return { code: 0, lines: [`daemon started (pid=${info.info.pid})`] };
    return { code: 0, lines: [`daemon started (pid unavailable — ${describe(info)})`] };
  } finally {
    await conn.close();
  }
}

async function daemonStop(deps: DaemonManageDeps): Promise<ManageResult> {
  const conn = await tryConnect(deps.transport);
  if (conn === undefined) return { code: 0, lines: ['no daemon running'] };
  // Read the pid first (for the honest "kill manually" fallback) — bounded; an old daemon answers
  // with an error reply (unsupported), so pid stays undefined but stop still proceeds.
  const info = await fetchInfo(conn, deps);
  const pid = info.kind === 'ok' ? info.info.pid : undefined;
  // Confirmation is the connection CLOSING (listener torn down + socket unlinked) — register the
  // close-await BEFORE sending shutdown so we never miss a fast close.
  const closed = awaitClose(conn, deps.clock, stopMs(deps));
  conn.send(shutdownEnvelope(2));
  if (await closed) {
    const pidPart = pid !== undefined ? ` (socket released, pid ${pid})` : ' (socket released)';
    return { code: 0, lines: [`daemon stopped${pidPart}`, RECONNECT_NOTE] };
  }
  // Did not close within the budget — wedged. Honest, never hang.
  await conn.close().catch(() => undefined);
  const killHint =
    pid !== undefined
      ? `pid ${pid} still running — kill it: kill ${pid}`
      : `pid unknown — find it: pgrep -f 'codemaster.*daemon'`; // matches legacy bare-daemon too
  return {
    code: 1,
    lines: [`couldn't stop daemon gracefully within ${stopMs(deps)}ms — ${killHint}`],
  };
}

async function daemonRestart(deps: DaemonManageDeps): Promise<ManageResult> {
  const stop = await daemonStop(deps);
  if (stop.code !== 0)
    // Couldn't stop (wedged) — do NOT start: a new daemon can't bind while the old still holds the
    // socket (EADDRINUSE → it exits). Honest: kill the old one first.
    return {
      code: 1,
      lines: [
        ...stop.lines,
        'not starting a new daemon (the old one still holds the socket) — kill it, then run `codemaster daemon start`',
      ],
    };
  const start = await daemonStart(deps);
  return {
    code: start.code,
    lines: [
      ...stop.lines,
      ...start.lines,
      'existing MCP clients must reconnect to pick up the new daemon',
    ],
  };
}

const RECONNECT_NOTE = 'any connected MCP clients must reconnect (the shared daemon is gone)';

type InfoOutcome =
  | { kind: 'ok'; info: DaemonInfo; sourceStale: boolean }
  | { kind: 'timeout' }
  | { kind: 'unsupported'; message: string };

/** Send one `daemon-info` request and await its reply, deadline-bounded. An error reply (an old
 *  daemon that doesn't know the kind) maps to `unsupported`, never a throw. */
async function fetchInfo(conn: TransportConnection, deps: DaemonManageDeps): Promise<InfoOutcome> {
  const id = 1;
  const outcome = await awaitReply(conn, deps.clock, daemonInfoEnvelope(id), id, replyMs(deps));
  if (outcome.kind === 'timeout') return { kind: 'timeout' };
  const reply = outcome.reply;
  if (reply.kind === 'daemon-info')
    return { kind: 'ok', info: reply.info, sourceStale: reply.sourceStale };
  if (reply.kind === 'error') return { kind: 'unsupported', message: reply.message };
  return { kind: 'unsupported', message: `unexpected reply kind ${reply.kind}` };
}

const describe = (o: InfoOutcome): string =>
  o.kind === 'timeout'
    ? 'unresponsive'
    : o.kind === 'unsupported'
      ? 'speaks an older protocol'
      : 'ok';

type ReplyOutcome = { kind: 'reply'; reply: WireReply } | { kind: 'timeout' };

/** Single in-flight request/reply, correlated by id, bounded by a deadline. A corrupt or
 *  unmatched line is ignored (the deadline is the backstop), never thrown into the transport. */
function awaitReply(
  conn: TransportConnection,
  clock: Clock,
  envelope: JsonValue,
  id: number,
  deadlineMs: number,
): Promise<ReplyOutcome> {
  return new Promise<ReplyOutcome>((resolve) => {
    let settled = false;
    const cancel = clock.schedule(deadlineMs, () => {
      if (settled) return;
      settled = true;
      resolve({ kind: 'timeout' });
    });
    conn.onMessage((raw) => {
      if (settled) return;
      const parsed = parseWireReply(raw);
      if (!parsed.ok || parsed.value.id !== id) return;
      settled = true;
      cancel();
      resolve({ kind: 'reply', reply: parsed.value });
    });
    conn.send(envelope);
  });
}

/** Await the connection closing (the `stop` confirmation), bounded. Resolves `true` on close,
 *  `false` on deadline overrun (a wedged daemon that never closed). */
function awaitClose(conn: TransportConnection, clock: Clock, deadlineMs: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const cancel = clock.schedule(deadlineMs, () => {
      if (settled) return;
      settled = true;
      resolve(false);
    });
    conn.onClose(() => {
      if (settled) return;
      settled = true;
      cancel();
      resolve(true);
    });
  });
}

const daemonInfoEnvelope = (id: number): JsonValue =>
  ({ id, kind: 'daemon-info' }) as unknown as JsonValue;
const shutdownEnvelope = (id: number): JsonValue =>
  ({ id, kind: 'shutdown' }) as unknown as JsonValue;

/** ms → a compact human duration (`45s`, `3m12s`, `2h05m`). */
function fmtUptime(ms: number): string {
  const totalS = Math.floor(ms / 1000);
  if (totalS < 60) return `${totalS}s`;
  const m = Math.floor(totalS / 60);
  if (m < 60) return `${m}m${String(totalS % 60).padStart(2, '0')}s`;
  const h = Math.floor(m / 60);
  return `${h}h${String(m % 60).padStart(2, '0')}m`;
}
