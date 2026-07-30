// The PUBLIC view type of a fanned type-anchored scan (t-162650) — what `construction_sites` /
// `discrimination_sites` carry on their plugin result and the ops layer renders into a verdict
// (`ops/scan-coverage.ts`). It lives in its own leaf, not inside the `scan-fanout.ts` driver, because
// the driver's other types (`FanoutScanSpec`, `FanoutScanOptions`, `ScanFanout`) are genuinely
// private while this one is part of `TsPluginApi`'s advertised return shape — a reader who treats the
// driver as private must not find an op-facing contract in it.
//
// Every field exists to answer ONE question the old bare `scanned: {literals, files}` block could
// not: was this `0` established, or merely not contradicted? So the counters come in matched pairs
// (walked/claimed, examined/candidates) — a numerator with no denominator is what let an agent read
// a four-file package scan as a repo scan.

/** What one fanned program contributed. Two independent shortfalls, and they must not be conflated:
 *  `walked < files` means the DEADLINE stopped the walk before this program's files ran out, so its
 *  unwalked files contributed no candidates at all; `examined < candidates` means the walk reached
 *  them but the shared BUDGET ran out. Both are LOADED programs we did not finish — a different fact,
 *  and a different remedy, from a config never loaded. */
export interface ScanProgramCoverage {
  label: string;
  /** Files CLAIMED — the denominator. Known before the walk starts. */
  files: number;
  /** Files actually WALKED. Equal to `files` unless the deadline cut the walk short; `candidates` is
   *  a count over these only, so a note that reads a shortfall off `candidates` would state a
   *  denominator that already excludes what it is trying to report. */
  walked: number;
  examined: number;
  candidates: number;
}

/** A program the fan contained but did NOT scan, and why. Each reason has its OWN remedy, so they are
 *  a closed union rather than one "skipped" flag:
 *   · `no-checkable-type` — the target does not resolve to a checkable type under THAT program's own
 *     options (vacuous / non-union there). Skipping is correct; judging its files against a type it
 *     does not have would flood or lie. The remedy is neither the budget nor a missing config.
 *   · `deadline` — the wall-clock budget was already spent when the fan reached it, so its checker was
 *     never warmed and its files were never enumerated.
 *   · `program-unavailable` — the LS could not produce a Program for it (an internal-tool failure).
 *
 *  Recorded because the alternative is the t-162650 defect returning through another door: a fan that
 *  silently narrows itself and then reports `complete` is a completeness claim over programs it never
 *  consulted. */
export interface SkippedProgram {
  label: string;
  reason: 'no-checkable-type' | 'deadline' | 'program-unavailable';
}

/** The positive scope of a fanned scan — WHAT was walked, per program, plus every reason the walk
 *  may be short of the question. Machine-readable so the op renders a verdict instead of prose
 *  (§3.4): `sites: 0` is only an assignability/identity verdict when this says the scan was
 *  complete. */
export interface ScanCoverage {
  /** Per-program, in fan order (the target's type authority first). */
  programs: ScanProgramCoverage[];
  /** Union of files CLAIMED — what the walk set out to cover. */
  files: number;
  /** Union of files actually WALKED (`=== files` unless the deadline cut in). Every count derived
   *  from node contents (`candidates`, `examined`) is a count over THESE files, so a note reporting
   *  scan scope must read this, never `files` — else an interrupted scan claims it walked what it
   *  only claimed. */
  walkedFiles: number;
  /** Union of files the fan COULD have walked, before `pathInclude`/`pathExclude`. `files === 0`
   *  with `eligibleFiles > 0` proves the path filter — not the program set — emptied the scan, which
   *  is the difference between a remedy that works and one that cannot (§3.6). */
  eligibleFiles: number;
  examined: number;
  candidates: number;
  /** The budget that bounded this scan (the op's `limit`, else the op's default). Carried rather than
   *  re-derived at the op, so the note naming the budget states the number actually spent — two
   *  `?? DEFAULT` expressions in two layers can drift; one field cannot. */
  limit: number;
  /** Programs the fan held but did not scan. Absent when the whole fan was scanned, so the common
   *  answer is unchanged; present, it demotes the scan below `complete`. */
  skipped?: SkippedProgram[];
  /** Files covered ONLY by the excluded no-config fallback primary — unscanned by design. Decided
   *  against the PRE-path-filter file set, so a file a real program covers but the caller's glob
   *  excluded is never counted here (that would blame a missing config for the caller's own scope). */
  fallbackOnlyFiles?: number;
  /** No real-config program contains the target: the scan ran on the no-config fallback, whose
   *  DEFAULT options resolve no `paths` and absorb whole-repo strays. */
  fallbackOnly?: true;
  /** The cooperative deadline expired mid-scan (§19) — the sites found are real, the scan is not
   *  finished. */
  deadlineHit?: true;
}
