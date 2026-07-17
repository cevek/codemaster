// The real `child_process.fork` adapter for process-mode isolation (§2). Kept behind a thin
// `EngineChildHandle` seam so `createProcessHost` is driven by a fake in unit tests and only
// the real-spawn smoke exercises an actual subprocess. The child is `node <bin> daemon
// serve-engine` — a fresh process whose `import.meta.url` base is codemaster's own source (same
// as the parent), so it resolves the SAME bundled `typescript`; no project-TS-resolution seam is
// needed at the current stage (§19). `--max-old-space-size` bounds the child's heap: a warm that
// would OOM the shared daemon dies here instead (t-167395).

import { fork } from 'node:child_process';
import process from 'node:process';
import type { JsonValue } from '../core/json.ts';

/** The subset of a forked child the host drives. A fake implements this in unit tests. */
export interface EngineChildHandle {
  readonly pid: number | undefined;
  send(frame: JsonValue): void;
  kill(signal: 'SIGTERM' | 'SIGKILL'): void;
  onMessage(cb: (raw: JsonValue) => void): void;
  /** Fires once when the child is gone — a clean exit, a crash/OOM (code+signal), or a spawn
   *  `error` (surfaced as `code=null, signal='ERROR'`). The host treats all three uniformly. */
  onExit(cb: (code: number | null, signal: string | null) => void): void;
}

export interface ForkEngineOpts {
  binPath: string;
  root: string;
  stateDir: string;
  version: string;
  /** Child heap ceiling (MB) — appended to the inherited `execArgv` so type-stripping and any
   *  other parent flags survive (replacing the list would drop them — a prod-only footgun). */
  maxOldSpaceMB: number;
  /** Test socket-dir seam, forwarded so a spawned child shares the parent's endpoint config. */
  sockDir: string | undefined;
}

export function forkEngineChild(opts: ForkEngineOpts): EngineChildHandle {
  const execArgv = [...process.execArgv, `--max-old-space-size=${opts.maxOldSpaceMB}`];
  const child = fork(opts.binPath, ['daemon', 'serve-engine'], {
    execArgv,
    // stdout is discarded (the child speaks ONLY over IPC, never stdout — §13); stderr inherits
    // so the child's debug/stderr sink is visible; `ipc` carries the JSON frames.
    stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
    env: {
      ...process.env,
      CODEMASTER_ENGINE_ROOT: opts.root,
      CODEMASTER_ENGINE_STATE_DIR: opts.stateDir,
      CODEMASTER_ENGINE_VERSION: opts.version,
      ...(opts.sockDir !== undefined ? { CODEMASTER_SOCK_DIR: opts.sockDir } : {}),
    },
  });
  return {
    get pid() {
      return child.pid;
    },
    send: (frame) => {
      // A send after the channel closed throws (ERR_IPC_CHANNEL_CLOSED) — the exit handler
      // already settled (or will settle) every pending request, so swallow it (§1 never-crash).
      try {
        // Frames are always object envelopes (never a bare JSON null), so `object` is the safe
        // narrowing to node's `Serializable` (which excludes a top-level null).
        child.send(frame as object);
      } catch {
        /* channel gone — exit handler owns the failure */
      }
    },
    kill: (signal) => {
      try {
        child.kill(signal);
      } catch {
        /* already dead */
      }
    },
    onMessage: (cb) => child.on('message', (m) => cb(m as JsonValue)),
    onExit: (cb) => {
      child.on('exit', (code, signal) => cb(code, signal));
      child.on('error', () => cb(null, 'ERROR'));
    },
  };
}
