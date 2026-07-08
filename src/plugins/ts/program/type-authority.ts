// The type-authority selection for a no-root repo (t-593802 / t-608842). A no-config FALLBACK primary
// globs the WHOLE repo under DEFAULT options, so its type-space wrongly absorbs a whole-repo `declare
// global`/`declare module` augmentation stray — a TYPE read on a MEMBER src symbol then reports a type
// the member's real tsconfig never yields (the never-lie §3 violation). This picks the DEEPEST-ENCLOSING
// real-config owner instead, as a PURE function of `nearestConfig` over the deterministic BUILT set, so
// the choice is load-order-independent (§16 cold==warm). Kept out of ls-host.ts (300-line cap).

import type ts from 'typescript';
import { toPosix } from '../../../support/fs/canonicalize.ts';

/** Primary-FIRST source-file lookup across programs, short-circuiting before `extras()` is evaluated —
 *  a primary-resident target must not eagerly force sibling construction (§5-L2 laziness). `extras` is
 *  a THUNK for exactly that reason. Returns the first program whose built program contains `absPosix`. */
export function findSourceFileAcross<P extends { getProgram(): ts.Program | undefined }>(
  absPosix: string,
  primary: P,
  extras: () => readonly P[],
): { sf: ts.SourceFile; program: P } | undefined {
  const primarySf = primary.getProgram()?.getSourceFile(absPosix);
  if (primarySf !== undefined) return { sf: primarySf, program: primary };
  for (const program of extras()) {
    if (program === primary) continue;
    const sf = program.getProgram()?.getSourceFile(absPosix);
    if (sf !== undefined) return { sf, program };
  }
  return undefined;
}

/** Structural minimum a candidate program must expose for authority selection. */
export interface AuthorityProgram {
  readonly configPath: string | undefined;
  containsFile(absPosix: string): boolean;
}

export interface TypeAuthorityDeps<P extends AuthorityProgram> {
  /** The primary's config, or `undefined` for the no-config fallback (the only routed case). */
  readonly configPath: string | undefined;
  readonly primary: P;
  /** The deterministic built set (primary + discovered siblings) — NEVER the session-dependent
   *  file-driven/explicit programs, so the choice is cold==warm. */
  readonly built: () => readonly P[];
  /** The single DEEPEST enclosing tsconfig.json of a file (pure over the FS). */
  readonly nearestConfig: (posix: string) => string | undefined;
  /** Primary-first source-file lookup — the owning program for a not-in-primary (e.g. sibling-only
   *  test) file; the resolution every symbol-addressed read already uses. */
  readonly primaryFirst: (posix: string) => P | undefined;
}

/** The program whose checker should answer a TYPE query for `posix`. Only a no-config FALLBACK primary
 *  reroutes (to the deepest-enclosing real-config owner that CONTAINS the file); a rooted primary and
 *  any file under no member fall through to the primary-first lookup — byte-identical to pre-fix. */
export function pickTypeAuthority<P extends AuthorityProgram>(
  posix: string,
  deps: TypeAuthorityDeps<P>,
): P {
  if (deps.configPath === undefined) {
    const near = deps.nearestConfig(posix);
    if (near !== undefined) {
      // `nearestConfig` returns ONE config and config paths are unique → at most one match, no
      // iteration-order tie-break. The owner must CONTAIN the file (a member stray is owned only once
      // injected, t-232769); an un-injectable stray owned by no real-config program falls through.
      for (const program of deps.built()) {
        if (program === deps.primary || program.configPath === undefined) continue;
        if (toPosix(program.configPath) === near && program.containsFile(posix)) return program;
      }
    }
  }
  return deps.primaryFirst(posix) ?? deps.primary;
}
