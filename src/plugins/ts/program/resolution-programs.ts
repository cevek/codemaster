// Which built programs may answer a RESOLUTION question about one file — the seam the ambiguity
// collapse re-asks when a file's own answering program cannot resolve an import's module spec
// (a loose-root primary globs a member's files WITHOUT the member's `paths`, t-000524).
//
// Two constraints shape it, and both are honesty constraints rather than tuning:
//
//   1. SELECTION MUST NOT BUILD. `builtContaining` answers containment with `containsFile`, which is
//      `service.getProgram()?.getSourceFile(...)` — so merely FILTERING with it materializes every
//      program in the set. On the loose-root monorepo this path exists for, that is ~25 programs in
//      one heap (~6.1 GB) — precisely the OOM the t-167395 discovery prune avoids by keeping navto on
//      the primary alone, and an in-process OOM kills the daemon (§1 ranks that below a wrong
//      answer). So membership is read from `isTracked` — an O(1) lookup in the file list globbed at
//      construction — and only the programs that actually own the file are ever built.
//   2. A FOREIGN CONFIG IS NOT AN AUTHORITY. A config that merely globs the file (a loose root, a
//      `tsconfig.build.json`) may carry its own `paths` and resolve the same specifier to a DIFFERENT
//      module. Letting it settle what the file's imports mean would collapse an alias into a
//      declaration the file does not name — a confident answer about the wrong symbol, the cardinal
//      lie (§3). So the file's OWN nearest enclosing tsconfig must be among the programs consulted;
//      when it is absent (undiscovered, never loaded) the answer is "we cannot say", not a guess
//      from whoever happens to glob the file.
//
// Structurally typed on the program so this stays a leaf, like `type-authority.ts` beside it.

/** The structural minimum a candidate program must expose for resolution selection. */
export interface TrackingProgram {
  /** This program's tsconfig (absolute posix), or `undefined` for the no-config fallback primary. */
  readonly configPath: string | undefined;
  /** Is `absPosix` in this program's globbed file set? Cheap — NO `getProgram()` build. */
  isTracked(absPosix: string): boolean;
}

export interface ResolutionProgramDeps<P extends TrackingProgram> {
  /** The deterministic built set (primary + discovered siblings) — never the session-dependent
   *  file-driven / explicit programs, so the selection is cold == warm (§16 invariant 3). */
  readonly built: () => readonly P[];
  /** The single deepest enclosing `tsconfig.json` of a file (pure over the FS, memoized). */
  readonly nearestConfig: (posix: string) => string | undefined;
}

/** The built programs that TRACK `posix`, or EMPTY when the file's own nearest enclosing tsconfig is
 *  not among them (constraint 2 above). Order is `built()`'s and carries no meaning — a caller must
 *  require agreement rather than take a first hit, so no ordering rule can leak into an answer. */
export function resolutionPrograms<P extends TrackingProgram>(
  posix: string,
  deps: ResolutionProgramDeps<P>,
): readonly P[] {
  const tracking = deps.built().filter((program) => program.isTracked(posix));
  if (tracking.length === 0) return [];
  const nearest = deps.nearestConfig(posix);
  // `undefined` means no enclosing tsconfig at all — then no program can claim to be the file's own
  // authority, and a foreign config's resolution is exactly what constraint 2 refuses.
  if (nearest === undefined) return [];
  return tracking.some((program) => program.configPath === nearest) ? tracking : [];
}
