// The process-mode child's heap ceiling (`--max-old-space-size`, §2/§9) — a pure decision over the
// repo's config + the size of this box. The impure readings (`os.totalmem()`,
// `process.constrainedMemory()`) stay at the fork edge (`process-host-factory.ts`); this file is
// arithmetic, so a test states a box size instead of mocking a machine.
//
// WHY THE BOX, NOT THE FILE COUNT. Auto-escalation fires because a repo measured OVERSIZED
// (`escalate.ts`), so the file count is the obvious-looking input for the ceiling — and it is the
// wrong one. Measured on a 6.1k-file pnpm monorepo: parse+bind of its primary program costs
// ~0.14 MB/file, a checker-backed `find_usages` over the SAME program ~0.85 MB/file. One `files × k`
// therefore fabricates a precision we do not have, and an under-prediction reproduces exactly the
// defect this ceiling exists to remove (an OOM 1 GB below what the box could serve). The count
// already did its job — as the escalation TRIGGER. The ceiling is a RESOURCE budget: its question is
// "how much may one workspace child claim of this machine", which only the machine answers.
//
// TOTAL RAM, NOT FREE RAM. A ceiling derived from free memory varies between two spawns of the same
// repo, so the identical call refuses under load and answers when idle — the §3.6 lie in resource
// clothing (an honest cap must be reproducible). `totalmem` is a stable statement about hardware.
//
// THE BOX IS THE CGROUP, WHEN THERE IS ONE. `os.totalmem()` reports the HOST's memory even inside a
// memory-limited container, so the host reading alone would derive a ceiling far ABOVE the container's
// wall (8192 MB inside a 2 GB container on a big host) — and a ceiling the kernel will not honor buys
// a SIGKILL, which the daemon can only report as `crash`, in place of V8's own recognizable heap OOM.
// Hence the reduction to the smaller reading. Its honest reach: the reduction changes the OUTCOME only
// for a limit in the ~8–16 GB band, because below that the floor takes over — a container smaller than
// ~8 GB still gets the floor's 4096 and can still be kernel-killed (unchanged by this policy, and
// tracked separately). The floor is deliberately not carved out for it: half of a small container is a
// heap so small that repos which fit today would start failing, and trading a real capability for a
// better-labelled failure is the wrong direction.

import type { CodemasterConfig } from '../config/config.ts';

/** Fraction of the box's RAM one workspace child may claim. Half: the measured need of a 6.1k-file
 *  monorepo (~5.2 GB live) must clear on a 16 GB laptop — the common dev box — and a quarter there
 *  would leave it at today's 4 GB. A limit is not a reservation, so the fraction bounds a runaway,
 *  it does not pre-commit the memory. */
const RAM_FRACTION = 0.5;

/** Floor = the historical default, so no small box regresses: an 8 GB machine keeps the ceiling it
 *  has today. (Note that on such a box the 6.1k-file class stays unanswerable — a deliberate cap,
 *  not an oversight; see `CEILING_MAX_MB`.) */
export const CEILING_MIN_MB = 4096;

/** Policy bound, and the reason a bigger box does not get a proportionally bigger ceiling: past
 *  ~8 GB per child the marginal repo that becomes answerable is rare, while an unbounded per-child
 *  limit lets ONE runaway workspace claim the machine and push it into swap — under §1 worse than
 *  either a crash or a refusal, because thrash stalls every workspace instead of failing one op.
 *  What it does NOT bound is the AGGREGATE: engines are capped by count (`maxEngines`), not by RSS, so
 *  several concurrently-heavy escalated children can still exceed the box — the cross-engine RSS
 *  governor that would bound that is roadmap (§9). The escape for a genuinely bigger machine is
 *  explicit: `daemon.maxOldSpaceMB`. */
export const CEILING_MAX_MB = 8192;

/** The memory this process may actually count on: the host reading, reduced to the cgroup limit when
 *  one is in force. `process.constrainedMemory()` is 0 (or absent on an older runtime) when
 *  unconstrained, so anything non-positive means "no constraint", never "no memory". Kept pure and
 *  separate from the ceiling arithmetic so the container case is asserted rather than assumed. */
export function boxMemoryBytes(
  totalMemBytes: number,
  constrainedMemBytes: number | undefined,
): number {
  if (constrainedMemBytes === undefined || !Number.isFinite(constrainedMemBytes))
    return totalMemBytes;
  if (constrainedMemBytes <= 0) return totalMemBytes;
  return Math.min(totalMemBytes, constrainedMemBytes);
}

/** What decided the ceiling — carried, not discarded, because the two consumers need it: the fork
 *  trace (§13: which ceiling did this child get, and who chose it) and the OOM failure, whose remedy
 *  differs per cause (`configured` → raise your own number; `cap` → the policy bound, raise it
 *  explicitly; `floor` → this box is small). */
export type CeilingCause = 'configured' | 'box' | 'cap' | 'floor';

export interface HeapCeiling {
  readonly maxOldSpaceMB: number;
  readonly cause: CeilingCause;
}

/** Resolve the child heap ceiling. `config.daemon.maxOldSpaceMB` wins VERBATIM — a user who states a
 *  number is given that number, never one we clamped for them (the bounds above are the DEFAULT's
 *  policy, not a validity rule). Otherwise: half the box, held between the no-regression floor and
 *  the anti-thrash cap. `boxMemBytes` is passed in (never read here) so this stays pure; a
 *  non-finite / non-positive reading is an unmeasurable box → the floor, never a fabricated size. */
export function resolveChildHeapMB(config: CodemasterConfig, boxMemBytes: number): HeapCeiling {
  const explicit = config.daemon?.maxOldSpaceMB;
  if (explicit !== undefined) return { maxOldSpaceMB: explicit, cause: 'configured' };
  if (!Number.isFinite(boxMemBytes) || boxMemBytes <= 0) {
    return { maxOldSpaceMB: CEILING_MIN_MB, cause: 'floor' };
  }
  const half = Math.floor((boxMemBytes * RAM_FRACTION) / 1024 / 1024);
  if (half <= CEILING_MIN_MB) return { maxOldSpaceMB: CEILING_MIN_MB, cause: 'floor' };
  if (half >= CEILING_MAX_MB) return { maxOldSpaceMB: CEILING_MAX_MB, cause: 'cap' };
  return { maxOldSpaceMB: half, cause: 'box' };
}

/** The one phrasing of "which ceiling, chosen by whom, and how to move it" — shared by the fork trace
 *  and the OOM failure so an agent and an operator read the same sentence about the same child. */
export function describeCeiling(ceiling: HeapCeiling): string {
  const by: Record<CeilingCause, string> = {
    configured: 'from daemon.maxOldSpaceMB',
    box: "half this machine's RAM — override with daemon.maxOldSpaceMB",
    cap: 'the default cap — raise it with daemon.maxOldSpaceMB on a box with the RAM to spare',
    floor: 'the default floor for a box this size — raise it with daemon.maxOldSpaceMB',
  };
  return `heap ceiling ${ceiling.maxOldSpaceMB} MB (${by[ceiling.cause]})`;
}
