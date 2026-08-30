// The stall diagnostic writer (t-095661). When the watchdog reaps a wedged/orphaned process — or a
// bounded deadline fires (§19 fold-in) — it drops a breadcrumb record to `~/.codemaster/stalls/`
// FIRST, then SIGKILLs. This is the honest form of the "dump file" ask: a JS stack from a wedged
// thread is uncapturable, but the breadcrumb says WHAT was running ("op:find_usages … started 340s
// ago") — the actual diagnostic value. The write is synchronous (the worker thread is not wedged)
// and fully wrapped: a write failure must never block the SIGKILL that follows — the kill is the
// guarantee, the file is best-effort.

import process from 'node:process';
import { mkdirSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export interface StallRecord {
  reason: 'wedge' | 'orphan' | 'deadline' | 'host-gone' | 'fault-loop';
  pid: number;
  /** The breadcrumb text — the op label + a bounded args preview. */
  op: string;
  startMs: number;
  elapsedMs: number;
  seq: number;
  ts: number;
}

/** Write a stall record synchronously. Returns the file path, or `null` on any failure (never
 *  throws — a wedged process must still be killed even if the diagnostic can't be persisted). */
export function writeStallRecord(stallDir: string, record: StallRecord): string | null {
  try {
    mkdirSync(stallDir, { recursive: true });
    const file = path.join(stallDir, `${record.ts}-${record.pid}.json`);
    writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
    return file;
  } catch {
    return null;
  }
}

/** The stall dir: `CODEMASTER_STALL_DIR` override, else `~/.codemaster/stalls` off the
 *  env-independent passwd home (mirroring `socket-path.ts` — must resolve the same whether spawned
 *  by a stripped-env host or a normal shell). */
export function resolveStallDir(): string {
  const override = process.env['CODEMASTER_STALL_DIR'];
  if (override !== undefined && override.length > 0) return override;
  return path.join(homeDir(), '.codemaster', 'stalls');
}

function homeDir(): string {
  try {
    return os.userInfo().homedir;
  } catch {
    return os.tmpdir();
  }
}
