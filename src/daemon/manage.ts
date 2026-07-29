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
import type { Transport } from '../support/transport/seam.ts';
import { connectOrSpawnDaemon, tryConnect } from './connect-or-spawn.ts';
import { forceRecoverDaemon, type ForceRecoverResult } from './force-recover.ts';
import { awaitClose, fmtUptime, shutdownEnvelope } from './manage-io.ts';
import { awaitRelease, describe, fetchInfo, releaseMs, replyMs } from './manage-probe.ts';

export interface DaemonManageDeps {
  transport: Transport;
  socketPath: string;
  clock: Clock;
  /** The daemon's kill-target-hint pidfile (t-000051). When set, a wedged `stop`/`restart`
   *  escalates to a pidfile-targeted force-kill; when absent it degrades to the manual-kill hint. */
  pidfilePath?: string;
  /** The force-kill escalation (injectable so tests drive each outcome deterministically without a
   *  real process; defaults to the real `forceRecoverDaemon`). */
  forceRecover?: typeof forceRecoverDaemon;
  /** Fire the detached daemon spawn (injectable so tests start an in-process daemon instead). */
  spawnDaemon: () => void;
  /** Bounded await-reply deadline for `daemon-info` (ms). Default 5000. */
  replyDeadlineMs?: number;
  /** Bounded await-close deadline for `stop` (ms). Default 10000. */
  stopTimeoutMs?: number;
  /** Bounded wait for a DRAINING daemon to release the socket before `start` spawns (ms).
   *  Default 5000. */
  releaseTimeoutMs?: number;
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

const DEFAULT_STOP_MS = 10_000;
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
    if (info.kind === 'shutting-down' || info.kind === 'closed')
      return {
        code: 0,
        lines: [
          info.kind === 'shutting-down'
            ? `daemon is shutting down (it answered, then began teardown) — socket: ${deps.socketPath}`
            : `daemon is exiting (it accepted the connection, then closed it without replying) — socket: ${deps.socketPath}`,
          'the next request spawns a fresh one; re-run `codemaster daemon status` to see it',
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
  const probe = await awaitRelease(deps);
  switch (probe.kind) {
    case 'serving':
      return {
        code: 0,
        lines: [
          `daemon already running (pid=${probe.info.pid}, uptime=${fmtUptime(probe.info.uptimeMs)})`,
        ],
      };
    case 'legacy':
      return {
        code: 0,
        lines: [
          'daemon already running (speaks an older protocol) — run `codemaster daemon restart` to pick up this version',
        ],
      };
    case 'wedged':
      // It holds the socket, so a spawn would lose the bind race and exit silently. Refuse, and
      // name the verb that CAN recover it (restart escalates to a pidfile-targeted kill).
      return {
        code: 1,
        lines: [
          `daemon running but UNRESPONSIVE (no reply in ${replyMs(deps)}ms) — not spawning a second one (it still holds the socket)`,
          'recover it: `codemaster daemon restart`',
        ],
      };
    case 'draining':
      return {
        code: 1,
        lines: [
          `daemon is still shutting down after ${releaseMs(deps)}ms and has not released the socket — re-run \`codemaster daemon start\``,
        ],
      };
    case 'none':
      break;
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
    // Connected, but nothing confirmed it is SERVING — the connect may have landed on a daemon
    // mid-teardown rather than the one we spawned. Reporting success here is what makes `restart`
    // claim a fresh daemon while none is running (§3.6): a start is claimed only when a daemon
    // answered as live. The wording claims no spawn either — the connect may have pre-empted it.
    return {
      code: 1,
      lines: [
        `connected to the socket, but nothing there confirmed it is serving (${describe(info)}) — run \`codemaster daemon status\``,
      ],
    };
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
  if (info.kind === 'closed')
    // The link dropped before it answered — this daemon was already exiting. Sending `shutdown`
    // into a dead socket and then awaiting a close that already happened would spend the whole
    // stop budget and escalate to a force-kill of a pid that is on its way out (§3.6).
    return { code: 0, lines: ['no daemon running (it was already exiting)'] };
  const pid = info.kind === 'ok' ? info.info.pid : undefined;
  // Confirmation is the connection CLOSING (listener torn down + socket unlinked) — register the
  // close-await BEFORE sending shutdown so we never miss a fast close.
  const closed = awaitClose(conn, deps.clock, stopMs(deps));
  conn.send(shutdownEnvelope(2));
  if (await closed) {
    const pidPart = pid !== undefined ? ` (socket released, pid ${pid})` : ' (socket released)';
    return { code: 0, lines: [`daemon stopped${pidPart}`, RECONNECT_NOTE] };
  }
  // Did not close within the budget — the front door is wedged. Escalate to a pidfile-targeted
  // force-kill (t-000051): the socket already proved it unresponsive, so this is a warranted kill,
  // not a guess. Never hang — force-recover is bounded at every step.
  await conn.close().catch(() => undefined);
  if (deps.pidfilePath !== undefined) {
    const recovered = await (deps.forceRecover ?? forceRecoverDaemon)({
      socketPath: deps.socketPath,
      pidfilePath: deps.pidfilePath,
      clock: deps.clock,
    });
    const mapped = mapForceRecover(recovered, stopMs(deps));
    if (mapped !== undefined) return mapped; // `undefined` = no target → manual fallback below.
  }
  return manualKillFallback(pid, stopMs(deps));
}

/** Map a force-kill outcome to a management result. `undefined` = no trustworthy pidfile target, so
 *  the caller degrades to the honest manual-kill hint. */
function mapForceRecover(r: ForceRecoverResult, budgetMs: number): ManageResult | undefined {
  switch (r.kind) {
    case 'killed':
      // NOT "socket released": a SIGKILLed daemon can't unlink its own socket, so the stale file
      // lingers until the next `connectOrSpawnDaemon` re-probe clears it (restart does this next).
      return {
        code: 0,
        lines: [`daemon was wedged — force-killed pid ${r.pid}`, RECONNECT_NOTE],
      };
    case 'already-gone':
      return {
        code: 0,
        lines: ['daemon was already gone — cleared its stale pidfile', RECONNECT_NOTE],
      };
    case 'target-changed':
      return {
        code: 0,
        lines: ['daemon was already recovered by another actor — run `codemaster daemon status`'],
      };
    case 'still-alive':
      return {
        code: 1,
        lines: [
          `couldn't stop daemon within ${budgetMs}ms and force-kill did not confirm — kill it: kill -9 ${r.pid}`,
        ],
      };
    case 'no-target':
      return undefined;
  }
}

/** The honest fallback when there is no pidfile hint: tell the agent which pid to kill (or how to
 *  find it). Matches a legacy bare-`daemon` process too. */
function manualKillFallback(pid: number | undefined, budgetMs: number): ManageResult {
  const killHint =
    pid !== undefined
      ? `pid ${pid} still running — kill it: kill ${pid}`
      : `pid unknown — find it: pgrep -f 'codemaster.*daemon'`;
  return { code: 1, lines: [`couldn't stop daemon gracefully within ${budgetMs}ms — ${killHint}`] };
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
