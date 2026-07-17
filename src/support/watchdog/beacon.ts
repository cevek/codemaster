// The process-global breadcrumb beacon (§1 never-hang, t-095661). A module singleton because it
// mirrors a single real thing — one process = one wedge domain. Engine code wraps each heavy op in
// `beacon.measure(...)`; several ops can be in flight at once on the one main thread (concurrent,
// non-nested — several engines share this beacon, unserialized against each other), so the beacon
// tracks a live set and publishes the OLDEST live op (the wedge candidate) to the single SAB slot.
// A watchdog worker (installed by `installWatchdog`) reads that slot and reaps a wedged main thread.
//
// INACTIVE BY DEFAULT: until `bind` is called (only `installWatchdog` does), `measure` is a bare
// passthrough — zero SAB traffic, zero allocation — so the ordinary CLI / test paths pay nothing
// and behave identically. This keeps the seam honest to §16 determinism: no watchdog, no effect.

import type { Clock } from '../../common/async/clock.ts';
import { systemClock } from '../../common/async/clock.ts';
import { viewsOf, writeBusy, writeIdle, type BeaconViews } from './beacon-sab.ts';
import { elideString } from '../../common/truncate/elide-string.ts';

const ARGS_PREVIEW_CAP = 160;

interface Crumb {
  text: string;
  startMs: number;
}

class Beacon {
  private views: BeaconViews | undefined;
  private clock: Clock = systemClock;
  /** LIVE ops keyed by a monotonic id — NOT a stack. Production runs CONCURRENT, non-nested async
   *  ops on the one main thread: several engines (one per workspace) share this process-global
   *  beacon and are NOT serialized against each other (each has its own single-flight queue), and
   *  the MCP layer does not serialize concurrent `tools/call`s. So completion order is not reverse
   *  push order — a LIFO pop would remove SOMEONE ELSE's crumb and leave a completed op's ancient
   *  `startMs` pinned to the slot, false-wedging a healthy process under op churn. Instead each op is
   *  removed by IDENTITY on exit, and we publish the OLDEST live op's start — the true wedge
   *  candidate (a genuinely stuck op never leaves the set, so it becomes and stays the oldest). */
  private readonly live = new Map<number, Crumb>();
  private nextId = 0;

  /** Activate the beacon over a shared buffer (called once by `installWatchdog`). */
  bind(sab: SharedArrayBuffer, clock: Clock): void {
    this.views = viewsOf(sab);
    this.clock = clock;
    this.live.clear();
    writeIdle(this.views);
  }

  /** Deactivate (test seam / stop): later `measure` calls are bare passthroughs again. */
  reset(): void {
    this.views = undefined;
    this.clock = systemClock;
    this.live.clear();
  }

  /** Wrap a heavy op: register its breadcrumb, run it, remove it by identity on exit — success OR
   *  throw — then republish the oldest remaining live op (or idle). A no-op passthrough when
   *  inactive. */
  async measure<T>(label: string, args: unknown, fn: () => Promise<T>): Promise<T> {
    const views = this.views;
    if (views === undefined) return fn();
    const id = this.nextId++;
    this.live.set(id, { text: breadcrumbText(label, args), startMs: this.clock.now() });
    this.publish(views);
    try {
      return await fn();
    } finally {
      this.live.delete(id);
      this.publish(views);
    }
  }

  /** Write the OLDEST live op to the slot (the wedge candidate), or clear it when nothing is live.
   *  O(live) over a set bounded by concurrent in-flight ops — small; never scales with repo size. */
  private publish(views: BeaconViews): void {
    let oldest: Crumb | undefined;
    for (const crumb of this.live.values()) {
      if (oldest === undefined || crumb.startMs < oldest.startMs) oldest = crumb;
    }
    if (oldest === undefined) writeIdle(views);
    else writeBusy(views, oldest.startMs, oldest.text);
  }
}

function breadcrumbText(label: string, args: unknown): string {
  const preview = previewArgs(args);
  return preview.length > 0 ? `${label} ${preview}` : label;
}

/** A short, bounded preview of an op's args — enough to say WHAT was running (the diagnostic value),
 *  never the whole payload. `JsonValue` args never throw `JSON.stringify`; the catch is belt only. */
function previewArgs(args: unknown): string {
  if (args === undefined || args === null) return '';
  try {
    const s = typeof args === 'string' ? args : JSON.stringify(args);
    if (s === undefined) return '';
    return elideString(s, ARGS_PREVIEW_CAP).text;
  } catch {
    return '';
  }
}

/** The process-global beacon. Inactive until `installWatchdog` binds a buffer. */
export const beacon = new Beacon();

/** Test seam: drop the bound buffer so a later test starts inactive (no cross-test leak). */
export function resetBeaconForTest(): void {
  beacon.reset();
}
