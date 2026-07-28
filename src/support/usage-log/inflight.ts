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
// small write + rename + unlink, never work that scales with the repo (§1).
//
// The two symmetric lies this module must not tell:
//   - a LOST fatal (a real crash that never becomes a record) — the bug being fixed;
//   - a FABRICATED fatal (a record for a call that did not die) — the same lie, inverted.
// Hence: writes are ATOMIC (write-temp + rename, so a reader never meets a half-written file), a
// promotion CLAIMS by rename (two racing starts can never both count one fatal), a breadcrumb whose
// owner is still alive is never called dead, and a claim left by a promoter that itself died is
// re-scannable rather than invisible-forever.
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

/** What a promotion pass did. `deferred` is disclosed rather than dropped: a consumer must be able
 *  to tell "there were N fatals" from "there were more, capped at N" (§3.4 no silent truncation). */
export interface PromotionOutcome {
  promoted: number;
  deferred: number;
}

/** Never promote more than this many orphans in one start — the promotion runs at process start,
 *  and an unbounded readdir-and-append would scale with however much junk accumulated (§1).
 *  Leftovers are NOT dropped: they stay on disk, are reported as `deferred`, and are promoted by a
 *  later start. */
const PROMOTE_CAP = 200;

/** …and never look at more than this many files while spending that budget, so the pass stays
 *  bounded even over a dir full of entries it cannot promote (§1). Anything past it is `deferred`. */
const SCAN_CAP = 2000;

/** A breadcrumb whose owner pid is STILL ALIVE but which is older than this is reported as
 *  `abandoned`, never as `crash`: at that age the pid has most likely been recycled, but the owner
 *  answering right now is not proof of death — and claiming death we cannot prove is the lie this
 *  module exists to prevent. Without the sweep such a file would linger forever. */
const ABANDONED_AGE_MS = 6 * 60 * 60 * 1000;

type Outcome = 'crash' | 'abandoned';

const NOOP_HANDLE: InflightHandle = { clear: () => undefined };

/** Only `.json` files are breadcrumbs. A partially-written temp (`.tmp`) is therefore invisible to
 *  a reader by construction — the write becomes visible atomically, at its rename. */
const SUFFIX = '.json';
/** A claimed breadcrumb KEEPS the `.json` suffix so that a promoter which itself dies mid-promotion
 *  leaves a file a later start can still see (an invisible claim = a permanently lost fatal). */
const CLAIM_MARK = '.claiming-';

export function inflightDir(usageDir: string): string {
  return path.join(usageDir, 'inflight');
}

/** Stamp a breadcrumb for one call. Returns a handle whose `clear()` removes it. Any failure
 *  degrades to a no-op handle — a telemetry write must never surface on the request path. */
export function writeInflight(usageDir: string, call: InflightCall, pid: number): InflightHandle {
  const dir = inflightDir(usageDir);
  const stem = path.join(dir, `${pid}-${call.ts}-${nextSeq()}`);
  const file = `${stem}${SUFFIX}`;
  const record: InflightRecord = { ...call, pid };
  let line: string;
  try {
    line = JSON.stringify(record);
  } catch {
    return NOOP_HANDLE; // non-serializable args — better no breadcrumb than a thrown request
  }
  // Write-temp + rename: `writeFileSync` alone is NOT atomic, so a concurrently-starting sibling
  // could read a truncated file. Under rename, the `.json` name appears whole or not at all.
  if (!publish(dir, `${stem}.tmp`, file, line)) return NOOP_HANDLE;
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

function publish(dir: string, tmp: string, file: string, line: string): boolean {
  try {
    ensureDir(dir);
    writeFileSync(tmp, line, 'utf8');
    renameSync(tmp, file);
    return true;
  } catch {
    // The memo may be stale (the dir was removed under us) — force it once, then give up.
    try {
      ensured.delete(dir);
      ensureDir(dir);
      writeFileSync(tmp, line, 'utf8');
      renameSync(tmp, file);
      return true;
    } catch {
      // A temp left by a failed rename is invisible to the scan (it is not `.json`), so nothing
      // else would ever remove it — unlink it here, and let the age sweep catch the ones lost to a
      // death between write and rename.
      try {
        unlinkSync(tmp);
      } catch {
        /* best-effort */
      }
      return false;
    }
  }
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
 *  are fixing. Never throws. */
export function promoteOrphanInflight(
  usageDir: string,
  record: (entry: UsageLogEntry) => void,
  now: number,
  selfPid: number = process.pid,
): PromotionOutcome {
  const dir = inflightDir(usageDir);
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return { promoted: 0, deferred: 0 }; // no inflight dir yet (the common case)
  }
  sweepTemps(dir, entries, now);
  // OLDEST FIRST, so a capped pass is deterministic and the longest-waiting fatal is reported first.
  const files = entries.filter((f) => f.endsWith(SUFFIX)).sort(byStampThenName);
  let promoted = 0;
  let examined = 0;
  for (const name of files) {
    // The PROMOTE cap counts PROMOTIONS, not files examined: a stable prefix of un-promotable
    // entries (a live sibling's in-flight calls — the normal state of a busy usage dir) would
    // otherwise eat the whole budget on every start and starve a real orphan behind them forever,
    // contradicting "leftovers are promoted by a later start". The separate SCAN cap is what keeps
    // the pass bounded (§1).
    if (promoted >= PROMOTE_CAP || examined >= SCAN_CAP) break;
    examined += 1;
    try {
      const claimed = claim(path.join(dir, name), selfPid, now);
      if (claimed === undefined) continue;
      record(crashEntry(claimed.record, claimed.outcome, now, claimed.reclaimed));
      promoted += 1;
      try {
        unlinkSync(claimed.file);
      } catch {
        /* the record is written; a leftover claim is re-scanned later, never silently lost */
      }
    } catch {
      /* one unreadable breadcrumb must never abort the reconciliation of the rest */
    }
  }
  return { promoted, deferred: files.length - examined };
}

/** The call's start stamp, embedded in `<pid>-<ts>-<seq>`; `Infinity` sorts an unparseable name
 *  last (it is junk, and must never starve a real orphan out of a capped pass). */
function stampOf(name: string): number {
  const stamp = Number(path.basename(name).split('-')[1]);
  return Number.isFinite(stamp) ? stamp : Infinity;
}

function byStampThenName(a: string, b: string): number {
  return stampOf(a) - stampOf(b) || (a < b ? -1 : a > b ? 1 : 0);
}

/** Remove temps stranded by a death between the write and its rename. They are not `.json`, so no
 *  other path would ever see them, and an unbounded dir would make every start's readdir cost grow
 *  (§1). Only well-aged temps are touched — a fresh one may belong to a live writer. */
function sweepTemps(dir: string, entries: readonly string[], now: number): void {
  for (const name of entries) {
    if (!name.endsWith('.tmp')) continue;
    const stamp = stampOf(name);
    if (!Number.isFinite(stamp) || now - stamp <= ABANDONED_AGE_MS) continue;
    try {
      unlinkSync(path.join(dir, name));
    } catch {
      /* best-effort */
    }
  }
}

/** Read a breadcrumb and, if it is a genuine orphan, take exclusive ownership of it by RENAME —
 *  atomic on POSIX, so two starts racing over the same dir can never both promote it (which would
 *  double-count the fatal). The loser's rename fails and it skips. */
function claim(
  file: string,
  selfPid: number,
  now: number,
):
  | { file: string; record: InflightRecord; outcome: Outcome; reclaimed: number | undefined }
  | undefined {
  // A file already carrying a claim mark was taken by an earlier promoter. Take it over ONLY if
  // that promoter is dead; a live promoter is mid-flight and owns it. Whether that dead promoter
  // got as far as WRITING its record is unknowable from here (it may have died between the write
  // and the unlink), so the recovered record says so rather than asserting a first-time promotion —
  // recovering is still right, because losing a fatal is the worse of the two errors.
  const claimer = claimerPidOf(file);
  if (claimer !== undefined && claimer !== selfPid && isAlive(claimer)) return undefined;
  const record = readRecord(file);
  if (record === undefined) {
    // Unreadable. Under the atomic write above this is genuine corruption rather than a partial
    // write — but only reap it once it is old enough that no writer can still be involved, and
    // never emit a record whose fields we would have to invent.
    reapCorrupt(file, now);
    return undefined;
  }
  if (record.pid === selfPid && claimer === undefined) return undefined; // our own live call
  const alive = isAlive(record.pid);
  if (alive && now - record.ts <= ABANDONED_AGE_MS) return undefined; // a live sibling's call
  // An owner that still answers is NOT proven dead, however old the call: report it as `abandoned`
  // (cause undetermined), never as a crash.
  const outcome = alive ? 'abandoned' : 'crash';
  const claimedFile = `${stripClaim(file)}${CLAIM_MARK}${selfPid}${SUFFIX}`;
  try {
    if (claimedFile !== file) renameSync(file, claimedFile);
  } catch {
    return undefined; // another start claimed it first
  }
  return { file: claimedFile, record, outcome, reclaimed: claimer };
}

/** The pid in a claim mark (`<stem>.claiming-<pid>.json`), or undefined for an unclaimed file. */
function claimerPidOf(file: string): number | undefined {
  const mark = file.lastIndexOf(CLAIM_MARK);
  if (mark < 0) return undefined;
  const pid = Number(file.slice(mark + CLAIM_MARK.length, file.length - SUFFIX.length));
  return Number.isInteger(pid) ? pid : undefined;
}

function stripClaim(file: string): string {
  const mark = file.lastIndexOf(CLAIM_MARK);
  return mark < 0 ? file.slice(0, file.length - SUFFIX.length) : file.slice(0, mark);
}

/** A corrupt breadcrumb is removed only once it is older than the abandon age — a fresh unreadable
 *  file could still belong to a writer we cannot see, and deleting it would lose a real fatal. */
function reapCorrupt(file: string, now: number): void {
  try {
    // An UNPARSEABLE name (`stampOf` → Infinity) has no age to wait out — it can belong to no
    // writer of ours, so it is reaped immediately. Keeping it would make it a permanent resident
    // eating the scan budget at every start.
    const stamp = stampOf(file);
    if (Number.isFinite(stamp) && now - stamp <= ABANDONED_AGE_MS) return;
    unlinkSync(file);
  } catch {
    /* best-effort */
  }
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
    // This reader reconstructs field-by-field, so anything not named here is DROPPED. `origin` is
    // read back explicitly (a lost one would silently re-merge the daemon's view into the
    // agent-facing accounting stream). Only the one known value is accepted — a foreign string is
    // treated as absent rather than propagated as a fact we cannot vouch for.
    ...(r['origin'] === 'daemon' ? { origin: 'daemon' as const } : {}),
  };
}

/** Liveness of the breadcrumb's owner. `kill(pid, 0)` throws ESRCH when the process is gone;
 *  EPERM means it exists but belongs to another user — ALIVE, not dead (mistaking it for dead
 *  would fabricate a crash). Any other error is treated as alive: never invent a fatal. */
function isAlive(pid: number): boolean {
  // `kill` reads 0 and negatives as "this process group" / "every process" — never a pid we could
  // have written, and a probe that would answer "alive" for a nonsense id. Not a live owner.
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (thrown) {
    return (thrown as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

/** The recovered record. Key-set is the ordinary entry's (existing consumers keep working) plus the
 *  additive `outcome` discriminator. `tool` / `ops` keep their ordinary meaning — naming the op that
 *  was in flight IS the point — and `durationMs` is `null`, not a fabricated 0: the moment the call
 *  stopped is unknown, so no duration can be honestly claimed. */
function crashEntry(
  record: InflightRecord,
  outcome: Outcome,
  now: number,
  /** Set when this breadcrumb was recovered from ANOTHER promoter's abandoned claim. */
  reclaimed: number | undefined,
): UsageLogEntry {
  const cause =
    outcome === 'crash'
      ? `the serving process (pid ${record.pid}) died with this call in flight; cause unknown (OOM / SIGKILL / shutdown)`
      : `pid ${record.pid} still answers, so this call is NOT proven to have died — it was left in flight for over ${ABANDONED_AGE_MS / 3_600_000}h (a wedged call, or a recycled pid), and if it ever completes it will be recorded separately`;
  // Honest about the one duplicate this design can produce: a promoter that died between writing
  // its record and unlinking its claim leaves work indistinguishable from work never done.
  const dup =
    reclaimed === undefined
      ? ''
      : ` Recovered from an abandoned claim by pid ${reclaimed}, which may already have written a record for this same call.`;
  // A daemon-side breadcrumb is the daemon's VIEW of a call the agent-facing process also recorded
  // (that one is the accounting record). Said in the prose too, so a human reading one line knows
  // not to count it as a separate call.
  const view =
    record.origin === 'daemon'
      ? " This is the DAEMON's view of the call, not an agent-facing call record: the bridge that issued it writes its own record separately (correlate on cwd + tool + ops, bridge ts ≤ this ts)."
      : '';
  return {
    ts: record.ts,
    durationMs: null,
    tool: record.tool,
    ops: record.ops,
    ok: false,
    cwd: record.cwd,
    args: record.args,
    response: `!! no response — ${cause}. Recovered from an in-flight breadcrumb at ${now}; durationMs is null because the moment the call stopped is unknown.${dup}${view}`,
    isError: true,
    outcome,
    ...(record.origin !== undefined ? { origin: record.origin } : {}),
  };
}
