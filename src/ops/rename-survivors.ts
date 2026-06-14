// The rename completeness signal (KS-1). The TS LS performs a faithful, compile-clean rename
// but leaves the OLD name alive two ways it does on purpose: it preserves a re-exported public
// name by ALIASING (`export { <new> as <old> }`), and its `findRenameLocations` does NOT walk
// `export *`, so a named re-export reached only through a star — and its consumers — keep
// spelling the old name. Both are correct edits; the gap is that the op's `{applied, touched}`
// envelope READS as a complete rename when the old name survives. This assembles the honest
// disclosure (§3.4 / §3.6) the op attaches — never blocking, never auto-fixing (§ spec).
//
// Two outputs, deliberately split by where each is VERIFIABLE (§3.2 — a span must match the
// bytes on disk at its `file:line`):
//   · `summary` — a plain statement of the plan, no span claim, so it's honest in EVERY mode
//     (dry-run preview included). The op puts it in the envelope `notes` always.
//   · `fields.oldNameSurvives` — the proof-carrying span lists. The alias spans describe the
//     post-rename content, so they only match disk AFTER a successful apply; the op attaches
//     this field to the applied-success envelope only (never to dry-run/refused/rolled-back).
//
// Both survivor classes are gathered op-side from the plugin's own machinery (no new resolver,
// § reuse): the re-export aliases come from `ts.reExportAliasSites` (an AST walk of the formatted
// post-rename content — not a text scan, so no comment/cast/`$`/unicode error), and the
// `export *` consumers are the symbol's `referenceSpans` (which DOES traverse `export *`) that
// the rename's touch-set never rewrote and that still SPELL the old name.

import type { JsonValue } from '../core/json.ts';
import type { Span } from '../core/span.ts';
import type { RepoRelPath } from '../core/brands.ts';

interface OldNameSurvives {
  /** `export { <new> as <old> }` re-export aliases the rename introduced to keep the public
   *  name — the old name survives as a live export. Spans valid only post-apply. */
  reExportAliases: Span[];
  /** Reference sites still spelling the old name, reached only through an `export *` chain the
   *  LS rename did not traverse — un-updated re-exports and their consumers. */
  exportStarConsumers: Span[];
  /** One-line human summary, mirrored into the envelope `notes`. */
  summary: string;
}

/**
 * Assemble the old-name-survives disclosure, or `undefined` when the rename is genuinely
 * complete (no re-export alias survived, no `export *` consumer left behind — so no false note).
 *
 * Returns `notes` (the always-verifiable summary) separately from `fields` (the proof-carrying
 * `oldNameSurvives` whose alias spans are valid only against the written file) so the op can
 * surface them in the right envelopes.
 *
 * @param reExportAliases   AST-found `export { new as old }` specifiers in the formatted output.
 * @param exportStarConsumers reference spans the rename's touch-set did NOT rewrite that still
 *   spell the old name — `referenceSpans` (which traverses `export *`) minus the touched files.
 */
export function buildOldNameSurvives(
  oldName: string,
  newName: string,
  reExportAliases: readonly Span[],
  exportStarConsumers: readonly Span[],
): { fields: Record<string, JsonValue>; notes: string[] } | undefined {
  if (reExportAliases.length === 0 && exportStarConsumers.length === 0) return undefined;
  // Plan-relative wording ("would not fully replace"): true in dry-run preview AND after apply,
  // and it makes NO span claim — so it is safe in every envelope.
  const summary =
    `rename → \`${newName}\` would not fully replace \`${oldName}\`: ` +
    `${reExportAliases.length} re-export alias(es) (\`export { ${newName} as ${oldName} }\`)` +
    ` and ${exportStarConsumers.length} site(s) reached only via \`export *\` keep \`${oldName}\``;
  const survives: OldNameSurvives = {
    reExportAliases: [...reExportAliases],
    exportStarConsumers: [...exportStarConsumers],
    summary,
  };
  return { fields: { oldNameSurvives: survives as unknown as JsonValue }, notes: [summary] };
}

/** A repo-relative path the rename touched / could-not-edit — the set the `export *` survivor
 *  filter subtracts. Built once by the op from the rename outcome. */
export function touchedSet(paths: readonly RepoRelPath[]): ReadonlySet<string> {
  return new Set(paths.map((p) => String(p)));
}
