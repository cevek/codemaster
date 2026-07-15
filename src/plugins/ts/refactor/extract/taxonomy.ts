// The TS-language-service extract/move failure taxonomy (front-renamer docs/ts-ls-failures.md).
// The LS's "Move to file" refactor (which BOTH `extract_symbol` — into a new dest — and
// `move_symbol` drive) refuses some shapes — we surface the refusal honestly with a category, never
// a half-written file or a crash. Two assertion shapes are KNOWN and RESCUABLE through the §4
// patched-LS fork:
//   - `Expected symbol to be a module` — several cross-referencing declarations in one file (e.g.
//     the moved block uses a css-module member);
//   - `Changes overlap` — the LS computed two overlapping text edits (e.g. two mutually-recursive
//     top-level functions), which stock TS asserts on instead of producing a clean refusal.
// Both route through the rescue (`requestEditsWithRescue`); when the rescue is unavailable or also
// can't, we FAIL with a SANITIZED message — never the raw internal `Debug Failure …` string the
// agent can't act on (§1 honesty / §3.6). Any OTHER internal Debug Failure is surfaced with its
// raw message (so a new shape stays visible for triage) — we never claim a category we haven't
// earned (§3.3).

import type ts from 'typescript';
import type { TsProjectHost } from '../../ls-host.ts';
import { messageOfThrown } from '../../../../common/result/construct.ts';

/** The specific `Expected symbol to be a module` assertion — several cross-referencing
 *  declarations in one file. */
export function isExtractAssertion(message: string): boolean {
  return message.includes('Expected symbol to be a module');
}

/** The `Changes overlap` assertion — the LS produced overlapping edits (e.g. two
 *  mutually-recursive top-level symbols). Stock TS throws a `Debug Failure` rather than refusing. */
export function isChangesOverlapAssertion(message: string): boolean {
  return message.includes('Changes overlap');
}

/** Any internal LS `Debug Failure` (a thrown assertion we must catch, but cannot diagnose
 *  more specifically). */
export function isLsDebugFailure(message: string): boolean {
  return message.includes('Debug Failure');
}

/** The two assertion shapes the §4 patched-LS rescue is meant to handle. */
function isRescuableAssertion(message: string): boolean {
  return isExtractAssertion(message) || isChangesOverlapAssertion(message);
}

/** What the agent should do; tailors the manual-fallback guidance per op. */
export type RefactorVerb = 'extract' | 'move';

/** Edits produced by the (possibly rescued) LS refactor. `rescued` → built by the patched fork,
 *  so the op surfaces a provenance note (§4). */
export interface RescuedEdits {
  edits: ts.RefactorEditInfo | undefined;
  rescued: boolean;
}

/** Honest, SANITIZED guidance for a recognized assertion the rescue could not resolve (whether
 *  the fork is unavailable OR it also asserted). Never contains the raw LS internal string. */
function sanitizedAssertionFailure(message: string, verb: RefactorVerb): string {
  if (isChangesOverlapAssertion(message)) {
    // `Changes overlap` is the ONLY proven fact — the LS computed two edits over the same region. We
    // do NOT attribute it to mutual recursion (an acyclic co-move hits this too when a symbol is moved
    // into a dest that already imports it; that specific class is now pre-empted upstream). State the
    // fact + the actionable remedy — co-move the interdependent cluster in one `transaction` — without
    // an unearned cause (§3.3).
    return `cannot ${verb}: the language service produced overlapping edits for this ${verb} — co-move the interdependent symbols together in one transaction, or ${verb} manually`;
  }
  // `Expected symbol to be a module`.
  return (
    `ts-ls-internal: a known TS language-service limitation on some shapes (e.g. several ` +
    `cross-referencing declarations in one file). The §4 patched-LS rescue could not produce a ` +
    `safe edit (the fork is not installed, its TS major differs from the project, or it also ` +
    `could not move this shape) — ${verb} the symbol manually.`
  );
}

/** Request refactor edits, routing the two KNOWN rescuable assertions through the §4 patched-LS
 *  rescue. Returns `{ edits, rescued }` on success, or `{ error }` with an honest message:
 *  SANITIZED (no raw debug text) for a recognized assertion; the raw message for an unrecognized
 *  `Debug Failure` (a new shape we surface rather than mislabel, §3.3); the plain message for any
 *  ordinary (non-assertion) throw. The caller NEVER half-writes — this runs before any edit is
 *  applied to the tree. */
export function requestEditsWithRescue(
  host: TsProjectHost,
  requestEdits: (service: ts.LanguageService) => ts.RefactorEditInfo | undefined,
  verb: RefactorVerb,
): RescuedEdits | { error: string } {
  try {
    return { edits: requestEdits(host.service), rescued: false };
  } catch (thrown) {
    const msg = messageOfThrown(thrown);
    if (!isRescuableAssertion(msg)) {
      if (isLsDebugFailure(msg)) {
        return {
          error: `ts-ls-internal: the LS hit an internal assertion — ${verb} manually (${msg})`,
        };
      }
      return { error: `${verb} failed: ${msg}` };
    }
    // §4 rescue: the stock LS asserted on a shape it can't handle. Retry through the patched fork;
    // the project's own §2.8 typecheck still gates the result. Unavailable or also-fails → an
    // honest, SANITIZED failure — never a guessed edit, never the raw internal string.
    const fallback = host.rescueService();
    if (fallback === undefined) return { error: sanitizedAssertionFailure(msg, verb) };
    try {
      return { edits: requestEdits(fallback), rescued: true };
    } catch {
      return { error: sanitizedAssertionFailure(msg, verb) };
    }
  }
}
