// The ONE `@internal`-TypeScript boundary the no-program syntactic paths sit on (ARCHITECTURE §4).
// `getNamedDeclarations` is a pure, project-agnostic SourceFile method navto itself is built on, but it
// is absent from the public `typescript.d.ts` — so the cast lives here, once, behind a single typed
// `as unknown as` block (never `any`), and every consumer (the fuzzy `search_symbol {syntactic:true}`
// scan, the `symbols_overview` catalogue, the `source {syntactic:true}` declaration reader) reads it
// through this module. Three copies of the cast would be three places a TS bump has to be noticed.
//
// CAPABILITY-GUARDED, per §4: the presence probe is memoized and each path checks it BEFORE scanning,
// so a TS version that drops the helper yields an honest `ToolFailure` — never a crash, never a
// guessed empty. `createPatternMatcher` (the other @internal helper) is probed SEPARATELY: a path that
// needs only declarations must not be refused because the fuzzy matcher went missing.

import ts from 'typescript';

interface SourceFileNamedDecls {
  getNamedDeclarations(): Map<string, readonly ts.Declaration[]>;
}

/** Every named declaration in the file, grouped by name — the declaration set navto ranks. */
export function namedDeclarations(sf: ts.SourceFile): Map<string, readonly ts.Declaration[]> {
  return (sf as unknown as SourceFileNamedDecls).getNamedDeclarations();
}

let hasNamedDecls: boolean | undefined;

/** One-shot memoized probe: does the bundled TS still expose `getNamedDeclarations`? */
export function namedDeclarationsAvailable(): boolean {
  if (hasNamedDecls !== undefined) return hasNamedDecls;
  try {
    const probe = ts.createSourceFile('__probe.ts', 'export const x = 1;', ts.ScriptTarget.Latest);
    hasNamedDecls =
      typeof (probe as unknown as { getNamedDeclarations?: unknown }).getNamedDeclarations ===
      'function';
  } catch {
    hasNamedDecls = false;
  }
  return hasNamedDecls;
}

let hasMatcher: boolean | undefined;

/** One-shot memoized probe: does the bundled TS still expose `createPatternMatcher`? */
export function patternMatcherAvailable(): boolean {
  if (hasMatcher !== undefined) return hasMatcher;
  hasMatcher =
    typeof (ts as unknown as { createPatternMatcher?: unknown }).createPatternMatcher ===
    'function';
  return hasMatcher;
}

/** The shared failure for a path whose @internal helper is gone — one message, one home. Names no
 *  op-specific remedy: the constant is read by paths with different escapes (a `syntactic:true` flag to
 *  drop, a catalogue with none), and a remedy that does not exist for the caller is worse than none. */
export const INTERNAL_UNAVAILABLE = {
  tool: 'ts-internal' as const,
  message:
    'the bundled TypeScript lacks the @internal getNamedDeclarations — the no-program syntactic scan is unavailable; the type-verified (program-building) ops still work',
};
