// Write the daemon's pidfile (t-000051 wedged-daemon recovery, spec-daemon-singleton §2/§19). A
// pidfile is a KILL-TARGET HINT, never a liveness oracle: the socket stays the only authority on
// "is a daemon up" (§3.5). The recovery path consults this file ONLY after the socket has already
// proven unresponsive-but-accepting, to learn WHICH pid to signal. So this module is pure fs + a
// record shape — daemon-agnostic (the daemon-server supplies the facts); the kill orchestration and
// its re-read/identity guard live in the daemon layer.
//
// The pidfile sits next to the socket (`<socket>.pid`), is written ATOMICALLY (temp-then-rename, so
// a reader never sees a half-written record — mirrors support/text-edits/write.ts), and MUST be
// written only AFTER a successful bind and removed on graceful shutdown, so a file's presence
// tracks a daemon that actually holds the socket. Every call is wrapped → never throws (§3.6).

import { mkdirSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import type { Result } from '../../core/result.ts';
import { fail, ok, messageOfThrown } from '../../common/result/construct.ts';

/** The facts a recovering actor needs to safely target a wedged daemon. `socket` is the endpoint
 *  this daemon bound (an identity cross-check — the recovery only kills a pid whose pidfile names
 *  the socket it is recovering); `startedAt` (epoch ms) + `version` disambiguate a rebind. */
export interface PidfileRecord {
  pid: number;
  socket: string;
  version: string;
  startedAt: number;
}

/** The pidfile path for a given daemon socket — the single source of truth for the location, so
 *  writer and reader can never drift. */
export function pidfilePathFor(socketPath: string): string {
  return `${socketPath}.pid`;
}

let tempCounter = 0;

/** Write `record` to `pidfilePath` atomically, creating parent dirs. Returns `ok(true)` or a
 *  `ToolFailure` (tool `'fs'`) — never throws. On failure no pidfile is left half-written. */
export function writePidfile(pidfilePath: string, record: PidfileRecord): Result<true> {
  const dir = path.dirname(pidfilePath);
  const temp = path.join(dir, `.${path.basename(pidfilePath)}.${process.pid}.${tempCounter++}.tmp`);
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(temp, JSON.stringify(record), 'utf8');
    renameSync(temp, pidfilePath);
    return ok(true);
  } catch (thrown) {
    try {
      rmSync(temp, { force: true });
    } catch {
      /* the temp may not exist — nothing to clean. */
    }
    return fail({
      tool: 'fs',
      message: `could not write pidfile ${pidfilePath}: ${messageOfThrown(thrown)}`,
    });
  }
}

/** Best-effort removal on graceful shutdown (and after a kill). A missing file is success — the
 *  point is only that no stale pidfile is left behind. Never throws. */
export function removePidfile(pidfilePath: string): void {
  try {
    unlinkSync(pidfilePath);
  } catch {
    /* ENOENT or a racing remover — nothing to do. */
  }
}
