// Pre-dispatch crash breadcrumbs (spec usage-telemetry, t-807677). The usage log records a call
// only AFTER dispatch returns, so a FATAL call — the in-process OOM that kills the whole serving
// process — leaves ZERO trace: `fail.jsonl` then reads as if the tool's worst outcome were a polite
// `bad_args`, and any triage driven off it under-counts fatals to zero. That is the never-lie
// contract (§3.4/§3.6) broken by omission.
//
// So each call drops a small breadcrumb file under `<usage-dir>/inflight/` BEFORE it runs and
// unlinks it after. A leftover file therefore means "the process died with this call in flight";
// the next start of a file logger PROMOTES it into `fail.jsonl` as an `outcome:'crash'` record
// carrying the tool, the op names, the cwd and the args.
//
// One file PER CALL, not one per process: `tools/call`s are concurrent (the MCP layer does not
// serialize them) and several processes share the one usage dir (bridge, `--in-process`, fallback),
// so a single overwritten file would drop a live sibling's breadcrumb. Cost is O(1) per call — one
// small `writeFileSync` + one `unlinkSync`, never work that scales with the repo (§1).
//
// Every path here is fully wrapped: telemetry must never touch the request path (§3.6).

import {
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import * as path from 'node:path';
import type { JsonValue } from '../../core/json.ts';
import type { InflightCall, InflightHandle, UsageLogEntry } from './entry.ts';

/** A breadcrumb as stored on disk: the call plus the pid that owns it (the liveness key). */
interface InflightRecord extends InflightCall {
  pid: number;
}

/** Never promote more than this many orphans in one start — the promotion runs at process start,
 *  and an unbounded readdir-and-append would scale with however much junk accumulated (§1).
 *  Leftovers are NOT dropped: they stay on disk and are promoted by a later start. */
const PROMOTE_CAP = 200;

/** A breadcrumb older than this is promoted even if its pid still answers — the pid was recycled,
 *  so liveness can no longer vouch for it. Without this, such a file would linger forever. */
const RECYCLED_PID_AGE_MS = 6 * 60 * 60 * 1000;

const NOOP_HANDLE: InflightHandle = { clear: () => undefined };

export function inflightDir(usageDir: string): string {
  return path.join(usageDir, 'inflight');
}

/** Stamp a breadcrumb for one call. Returns a handle whose `clear()` removes it. Any failure
 *  degrades to a no-op handle — a telemetry write must never surface on the request path. */
export function writeInflight(usageDir: string, call: InflightCall, pid: number): InflightHandle {
  const dir = inflightDir(usageDir);
  const file = path.join(dir, `${pid}-${call.ts}-${nextSeq()}.json`);
  const record: InflightRecord = { ...call, pid };
  let line: string;
  try {
    line = JSON.stringify(record);
  } catch {
    return NOOP_HANDLE; // non-serializable args — better no breadcrumb than a thrown request
  }
  try {
    ensureDir(dir);
    writeFileSync(file, line, 'utf8');
  } catch {
    // Retry once through a forced mkdir: the memo may be stale (the dir was removed under us).
    try {
      ensured.delete(dir);
      ensureDir(dir);
      writeFileSync(file, line, 'utf8');
    } catch {
      return NOOP_HANDLE;
    }
  }
  return {
    clear() {
      try {
        unlinkSync(file);
      } catch {
        /* already gone / disk error — a stale file is promoted later, never a crash here */
      }
    },
  };
}

let seq = 0;
function nextSeq(): number {
  return seq++;
}

/** `mkdirSync` on every call would dominate the breadcrumb's cost (it is on the request path), so
 *  the directory is created once per process per dir; a failed write re-forces it. */
const ensured = new Set<string>();
function ensureDir(dir: string): void {
  if (ensured.has(dir)) return;
  mkdirSync(dir, { recursive: true });
  ensured.add(dir);
}

/** Promote every ORPHANED breadcrumb (its owner is gone) into `fail.jsonl` via `record`, then
 *  remove it. Called once when a file-backed logger is constructed at a process start.
 *
 *  A breadcrumb whose pid is still ALIVE belongs to a concurrently-serving sibling process and is
 *  left untouched — promoting it would invent a fatal that never happened, the same lie class we
 *  are fixing. Returns how many records were promoted (for tests / callers; never throws). */
export function promoteOrphanInflight(
  usageDir: string,
  record: (entry: UsageLogEntry) => void,
  now: number,
  selfPid: number = process.pid,
): number {
  const dir = inflightDir(usageDir);
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith('.json'));
  } catch {
    return 0; // no inflight dir yet (the common case) — nothing to reconcile
  }
  let promoted = 0;
  for (const name of files.slice(0, PROMOTE_CAP)) {
    try {
      const claimed = claim(path.join(dir, name), selfPid, now);
      if (claimed === undefined) continue;
      record(crashEntry(claimed.record, now));
      promoted += 1;
      try {
        unlinkSync(claimed.file);
      } catch {
        /* the record is already written; a leftover claim file is inert */
      }
    } catch {
      /* one unreadable breadcrumb must never abort the reconciliation of the rest */
    }
  }
  return promoted;
}

/** Read a breadcrumb and, if it is a genuine orphan, take exclusive ownership of it by RENAME —
 *  atomic on POSIX, so two starts racing over the same dir can never both promote it (which would
 *  double-count the fatal). The loser's rename fails and it skips. */
function claim(
  file: string,
  selfPid: number,
  now: number,
): { file: string; record: InflightRecord } | undefined {
  const record = readRecord(file);
  if (record === undefined) {
    // Unparseable / truncated (a crash mid-write). Nothing can be honestly attributed — drop it
    // rather than emit a record whose fields we would have to invent.
    try {
      unlinkSync(file);
    } catch {
      /* best-effort */
    }
    return undefined;
  }
  if (record.pid === selfPid) return undefined; // our own live call
  if (isAlive(record.pid) && now - record.ts <= RECYCLED_PID_AGE_MS) return undefined; // live sibling
  const claimedFile = `${file}.claiming-${selfPid}`;
  try {
    renameSync(file, claimedFile);
  } catch {
    return undefined; // another start claimed it first
  }
  return { file: claimedFile, record };
}

function readRecord(file: string): InflightRecord | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined;
  const r = parsed as Record<string, unknown>;
  if (
    typeof r['ts'] !== 'number' ||
    typeof r['tool'] !== 'string' ||
    typeof r['pid'] !== 'number'
  ) {
    return undefined;
  }
  return {
    ts: r['ts'],
    tool: r['tool'],
    ops: Array.isArray(r['ops']) ? r['ops'].filter((o): o is string => typeof o === 'string') : [],
    cwd: typeof r['cwd'] === 'string' ? r['cwd'] : '',
    args: (r['args'] ?? null) as JsonValue,
    pid: r['pid'],
  };
}

/** Liveness of the breadcrumb's owner. `kill(pid, 0)` throws ESRCH when the process is gone;
 *  EPERM means it exists but belongs to another user — ALIVE, not dead (mistaking it for dead
 *  would fabricate a crash). Any other error is treated as alive: never invent a fatal. */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (thrown) {
    return (thrown as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

/** The crash record. Key-set is the ordinary entry's (existing consumers keep working) plus the
 *  additive `outcome:'crash'` discriminator. `tool` / `ops` keep their ordinary meaning — naming
 *  the op that killed the process IS the point — and `durationMs` is `null`, not a fabricated 0:
 *  the moment of death is unknown, so no duration can be honestly claimed. */
function crashEntry(record: InflightRecord, now: number): UsageLogEntry {
  return {
    ts: record.ts,
    durationMs: null,
    tool: record.tool,
    ops: record.ops,
    ok: false,
    cwd: record.cwd,
    args: record.args,
    response:
      `!! no response — the serving process (pid ${record.pid}) died with this call in flight; ` +
      `cause unknown (OOM / SIGKILL / shutdown). Recovered from an in-flight breadcrumb at ${now}; ` +
      `durationMs is null because the moment of death is unknown.`,
    isError: true,
    outcome: 'crash',
  };
}
