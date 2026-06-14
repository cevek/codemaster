// The TS-language-service extract failure taxonomy (front-renamer docs/ts-ls-failures.md).
// The LS's "Move to a new file" refactor refuses some shapes — we surface the refusal
// honestly with a category, never a half-written file or a crash. We distinguish the
// SPECIFIC module-extraction assertion (which earns the cross-reference workaround note)
// from any other internal Debug Failure (surfaced with only its raw message — never claim a
// category we haven't earned, §3.3).

/** The specific `Expected symbol to be a module` assertion — the one the workaround note
 *  describes (several cross-referencing declarations in one file). */
export function isExtractAssertion(message: string): boolean {
  return message.includes('Expected symbol to be a module');
}

/** Any internal LS `Debug Failure` (a thrown assertion we must catch, but cannot diagnose
 *  more specifically). */
export function isLsDebugFailure(message: string): boolean {
  return message.includes('Debug Failure');
}

export const EXTRACT_ASSERTION_NOTE =
  'a known TS language-service limitation on some shapes (e.g. several cross-referencing ' +
  'declarations in one file) — cut the symbol manually. (The patched-LS rescue, spec §4, ' +
  'is not wired yet.)';
