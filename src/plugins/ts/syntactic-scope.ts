// The scope every no-program SYNTACTIC path answers within — stated once, read by every op that offers
// one (`search_symbol {syntactic:true}`, `source {syntactic:true}`, `symbols_overview`).
//
// It lives beside `syntactic-surface.ts` because it is a claim about what THAT function scans. Prose
// kept in `ops/` would go false the moment the surface changed, with nothing linking the two — no
// import, no type, no test. `INTERNAL_UNAVAILABLE` (syntactic-internal.ts) is the same kind of
// agent-facing sentence about the same layer's fact, and sits in the plugin for the same reason.
//
// Stated POSITIVELY (§3.6 report-capability): what WAS scanned, then what was not. Never "may have
// missed". And never "a degraded version of the checker path": the surface is WIDER on two axes — a
// file no tsconfig includes is scanned here, and a nested / member / destructured declaration is
// addressable here while the checker path's name resolution only anchors top-level ones — so an agent
// reading "syntactic" as strictly worse would skip it exactly where it is the more complete of the two.
// What it cannot do is verify types.
//
// TWO MECHANISMS, and the STATIC prose names the default explicitly (t-810757). The surface is normally
// listed by git; a workspace git cannot list falls back to a bounded filesystem walk whose coverage
// differs in both directions, and an answer built on that walk says so. Encoding the default here is
// what makes the ABSENCE of the mode line informative rather than an unspoken assumption: no line means
// the stated default held, not "nobody checked". An origin we could not establish at all prints its own
// line for the same reason — an anomaly must look like one, never like the norm.

import { elideString } from '../../common/truncate/elide-string.ts';
import type { SurfaceProvenance } from './syntactic-cache.ts';

/** The SHORT scope clause, for a note too dense to carry `SYNTACTIC_SCOPE` whole (the
 *  `symbols_overview` one-liner). Same claim, same home — a second hand-written wording in an op is
 *  how three copies went stale before.
 *
 *  It names the LISTING as the default rather than asserting it: the note is emitted on every
 *  answer, including the ones the walk produced, where "scanned git-tracked source" would be flatly
 *  false — and a sentence that asserts a mechanism and then hedges it in the same breath leaves the
 *  reader to pick which half to believe, beside a `surface` field that already says which. Assert
 *  only what holds in every mode; let the mode line carry the specifics (§3.6). */
export const SURFACE_SCOPE_CLAUSE =
  'the source surface under the workspace root — git-listed by default (tracked plus untracked-not-ignored), a bounded filesystem walk where git cannot list the workspace; an answer scanned by anything but the default says so on its `surface` line. An outside-root tsconfig include is covered by neither';

/** What the scan covered, what it did not, and the axes on which it beats the checker path. Written
 *  to hold in EVERY mode (see `SURFACE_SCOPE_CLAUSE`): it ships in static op notes / arg schemas,
 *  where no provenance exists to qualify it. */
export const SYNTACTIC_SCOPE = `scans ${SURFACE_SCOPE_CLAUSE} — complete there for declarations carrying a plain-identifier name, and WIDER than the type-verified path on two axes: a file no tsconfig includes is scanned, and a nested/member/destructured declaration is addressable. Not type-verified. Use the default path for an outside-root include/reference.`;

/** git's refusal as ONE bounded line: the raw failure is the wrapped command echo plus git's own
 *  stderr on its own line, and this note rides every answer from a non-git workspace. Newlines are
 *  folded and the whole thing capped — the cause stays readable, the standing cost stays small (§12). */
function compactCause(raw: string): string {
  return elideString(raw.replace(/\s+/g, ' ').trim(), CAUSE_CAP).text;
}

const CAUSE_CAP = 160;

/** The per-answer surface-mode line. `undefined` only when the default (git) listing held — its terms
 *  are already in `SYNTACTIC_SCOPE`, so a line there would be a standing token tax restating the
 *  documented norm. Every OTHER state prints, because the static prose does not describe it: the walk
 *  surface (whose coverage differs in both directions) and an origin that was never established. */
export function surfaceModeNote(provenance: SurfaceProvenance | undefined): string | undefined {
  if (provenance === undefined) {
    return '!! SURFACE ORIGIN NOT ESTABLISHED — this answer does not record whether its scan was listed by git or by the filesystem walk, so neither scope is claimed for it.';
  }
  if (provenance.origin === 'git') return undefined;
  const why =
    provenance.gitUnavailable === undefined
      ? ''
      : ` (git: ${compactCause(provenance.gitUnavailable)})`;
  const bound =
    provenance.incomplete === undefined
      ? ''
      : ` !! INCOMPLETE SCAN — the walk did not reach everything: ${provenance.incomplete}`;
  return (
    `!! SURFACE = FILESYSTEM WALK, not the git listing${why}. Coverage differs BOTH ways: .gitignore is NOT ` +
    'evaluated, so build output under a non-standard directory name is catalogued as source; and the walk ' +
    'skips the name-ignored dirs (node_modules/dist/build/.next/…) plus files over 1 MB, which the git ' +
    'listing does NOT skip — so a real source file under one of those names is MISSING here while it would ' +
    `be present in a git workspace.${bound}`
  );
}
