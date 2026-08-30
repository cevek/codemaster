// Last-resort process fault handlers (t-216182). The naive `process.on('uncaughtException',
// write-to-stderr)` handler is itself a hang-with-a-CPU-price: when the host is gone the stdio fds
// are dead sockets, the handler's own stderr write throws EPIPE, which re-enters the handler —
// an infinite exception storm at 100% CPU (each iteration formats a full stack through the
// type-stripping source-position lookup). Three rules, each closing one arm of that loop:
//
//   1. The handler NEVER throws — every write it makes is wrapped.
//   2. A host-gone code (EPIPE / stream-destroyed on our own transport) is not a fault to survive
//      but proof the peer died: leave a stall record and exit — but ONLY where stdio/IPC IS the
//      transport (`exitOnHostGone`). The machine-wide daemon must not die because one bridge
//      socket vanished.
//   3. A repeat-guard: a fault storm (N uncaughts inside a window) means we are looping, not
//      serving — one `fault-loop` stall record, then exit. Swallow-and-continue over a REPEATING
//      fault is the §1 hang with a CPU price.

import process from 'node:process';
import { resolveStallDir, writeStallRecord } from './stall-dir.ts';

/** Codes that mean OUR transport peer is gone (the MCP host / the forking parent). */
const HOST_GONE_CODES: readonly string[] = [
  'EPIPE',
  'ERR_STREAM_DESTROYED',
  'ERR_STREAM_WRITE_AFTER_END',
];

const FAULT_WINDOW_MS = 30_000;
const FAULT_LIMIT = 20;

export interface FatalHandlerOptions {
  /** Message prefix + the stall record's process label. */
  label: string;
  /** Exit on a host-gone code. On ONLY where stdio/IPC is the serving transport. */
  exitOnHostGone: boolean;
  /** Extra host-gone codes for this transport (engine-child adds ERR_IPC_CHANNEL_CLOSED). */
  extraHostGoneCodes?: readonly string[];
  /** Seams for tests; defaults are the real process. */
  stallDir?: string;
  write?: (line: string) => void;
  exit?: (code: number) => void;
  writeStall?: typeof writeStallRecord;
  now?: () => number;
}

export type FatalHandler = (kind: 'exception' | 'rejection', err: unknown) => void;

function safeStderr(line: string): void {
  try {
    process.stderr.write(line);
  } catch {
    /* stderr itself may be the dead socket — rule 1: never throw */
  }
}

function codeOf(err: unknown): string | undefined {
  if (typeof err === 'object' && err !== null && 'code' in err) {
    const code = (err as { code: unknown }).code;
    if (typeof code === 'string') return code;
  }
  return undefined;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Build the handler (pure over its seams — unit-testable without touching `process.on`). */
export function makeFatalHandler(options: FatalHandlerOptions): FatalHandler {
  const write = options.write ?? safeStderr;
  const exit = options.exit ?? ((code: number): void => process.exit(code));
  const writeStall = options.writeStall ?? writeStallRecord;
  const now = options.now ?? Date.now;
  const stallDir = options.stallDir ?? resolveStallDir();
  const hostGone = new Set([...HOST_GONE_CODES, ...(options.extraHostGoneCodes ?? [])]);
  const faultTimes: number[] = [];

  return (kind, err): void => {
    const ts = now();
    const message = messageOf(err);
    const code = codeOf(err);
    try {
      write(`${options.label}: ${kind === 'rejection' ? 'unhandled rejection: ' : ''}${message}\n`);
    } catch {
      /* rule 1 */
    }
    if (options.exitOnHostGone && code !== undefined && hostGone.has(code)) {
      writeStall(stallDir, {
        reason: 'host-gone',
        pid: process.pid,
        op: `${options.label}: ${code} ${message}`,
        startMs: 0,
        elapsedMs: 0,
        seq: 0,
        ts,
      });
      exit(1);
      return;
    }
    faultTimes.push(ts);
    while (faultTimes.length > 0 && ts - (faultTimes[0] ?? ts) > FAULT_WINDOW_MS)
      faultTimes.shift();
    if (faultTimes.length >= FAULT_LIMIT) {
      writeStall(stallDir, {
        reason: 'fault-loop',
        pid: process.pid,
        op: `${options.label}: ${faultTimes.length} uncaught faults in ${FAULT_WINDOW_MS / 1000}s; last: ${code ?? ''} ${message}`,
        startMs: faultTimes[0] ?? ts,
        elapsedMs: ts - (faultTimes[0] ?? ts),
        seq: faultTimes.length,
        ts,
      });
      exit(1);
    }
  };
}

/** Install the handler on `process` for both fault channels (composition-root call). */
export function installFatalHandlers(options: FatalHandlerOptions): void {
  const handler = makeFatalHandler(options);
  process.on('uncaughtException', (err) => handler('exception', err));
  process.on('unhandledRejection', (err) => handler('rejection', err));
}
