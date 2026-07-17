// The queryable-program view the cross-program fan-out (`ls-host.ts`) composes — the primary or a
// sibling. Extracted from `ls-host.ts` (300-line cap) so the interface can be shared with the
// discovery-prune coverage test (`../discovery-prune.ts`) without an import cycle. Backed by a
// `SingleProgram` at runtime (which is a structural superset), so exposing a member here is free —
// no impl change, just widening what a `TsProgram`-typed consumer may read.

import type ts from 'typescript';

/** One queryable program exposed to the cross-program fan-out — the primary or a sibling. */
export interface TsProgram {
  readonly service: ts.LanguageService;
  /** Provenance label (`tsconfig.json` / `tsconfig.test.json`) for status + cross-program origin. */
  readonly label: string;
  getProgram(): ts.Program | undefined;
  /** Every tracked file (absolute posix) — this program's tsconfig glob (JS extensions present only
   *  under `allowJs`). Cheap: globbed at construction, no `getProgram()` build. The discovery-prune
   *  coverage test reads it to detect an `allowJs` or out-of-root sibling (t-167395). */
  fileNames(): readonly string[];
  /** Is `absPosix` a source file in this built program right now? */
  containsFile(absPosix: string): boolean;
}
