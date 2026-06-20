// `css_cascade` — the resolved-cascade view (spec-css-cascade-op): for a CSS-module class
// (or a selector's subject), every rule across the in-scope sheets that targets it, ordered
// by specificity, with the WINNING declaration per property + the losers. The trap it
// surfaces: a higher-specificity descendant/attribute/state rule in ANOTHER sheet beating a
// local `.foo`. Honest `partial` first-class (§3/§19) — cross-module / state / computed
// contributors are named and ordered but never claimed as a proven winner.

import { z } from 'zod';
import type { JsonValue } from '../core/json.ts';
import type { RepoRelPath } from '../core/brands.ts';
import type { Confidence } from '../core/span.ts';
import { fail, failFromThrown, ok } from '../common/result/construct.ts';
import { tag } from '../common/shape-tag/tag.ts';
import type { CascadeInput, CascadeProperty, ScssPluginApi } from '../plugins/scss/plugin.ts';
import { defineOp } from './registry.ts';
import type { Cell, TableSpec } from './registry.ts';

/** The per-property WINNER table (the verdict): one row per property, the declaration that
 *  wins the cascade. `partial` confidence + a note carry the honesty — a cross-module or
 *  state winner is reported, never silently upgraded to a proven fact. */
const cssCascadeTable: TableSpec<JsonValue> = {
  columns: [
    { name: 'prop', type: 'text' },
    { name: 'value', type: 'text' },
    { name: 'specificity', type: 'text' },
    { name: 'winner_file', type: 'text' },
    { name: 'winner_selector', type: 'text' },
    { name: 'important', type: 'int' },
    { name: 'confidence', type: 'text' },
    { name: 'note', type: 'text' },
  ],
  rows(data) {
    const properties = (data as { properties?: CascadeProperty[] }).properties ?? [];
    return properties.map((p): readonly Cell[] => [
      p.prop,
      p.winner.value,
      p.winner.specificity,
      p.winner.file,
      p.winner.selector,
      p.winner.important ? 1 : 0,
      p.winner.confidence,
      p.winner.note ?? null,
    ]);
  },
  notes(data) {
    return (data as { notes?: string[] }).notes ?? [];
  },
};

const argsSchema = z
  .strictObject({
    file: z.string().optional(),
    class: z.string().optional(),
    selector: z.string().optional(),
    pathInclude: z.array(z.string()).optional(),
    pathExclude: z.array(z.string()).optional(),
  })
  .refine((a) => (a.file !== undefined && a.class !== undefined) !== (a.selector !== undefined), {
    message: 'pass EITHER {file, class} (a CSS-module class) OR {selector}, not both/neither',
  });

export const cssCascadeOp = defineOp({
  name: 'css_cascade',
  summary:
    'Resolved cascade for a CSS-module class: rules targeting it across sheets, ordered by specificity, winner per property',
  mutating: false,
  requires: ['scss'],
  argsSchema,
  argsHint:
    '{ file+class: string, OR selector: string, pathInclude?: string[], pathExclude?: string[] }',
  example: { args: { file: 'src/button.module.scss', class: 'button' } },
  notes: [
    'a rule TARGETS the class when its rightmost compound (the subject) carries it — `.parent .foo` and `.foo[aria-x]` target `foo`; `.foo .bar` does NOT (foo is only an ancestor there).',
    'cross-module is syntactic only: CSS-module class names are per-file scoped, so a same-named class in ANOTHER sheet is a different runtime class unless composed/:global/applied to the same element — such a winner is named & ordered but stays `partial` (§19).',
    'a winner is `certain` only when same-module, unconditional (no descendant/state/attribute/:not context), statically valued, and untied; state/attribute/@media/interpolated/computed/cross-module → `partial` with the reason, never a false resolved winner.',
    'scopeable by pathInclude/pathExclude (globs over the .scss path); the owning sheet is always searched. Searches the currently-INDEXED stylesheet set (`.scss`/`.sass`/`.css`); a just-created sheet may be missed until reindex, but the owning sheet named in {file} is always read fresh. A no-match answer is `partial`, not a proven absence.',
  ],
  table: cssCascadeTable,
  async run(ctx, args) {
    const scss = ctx.plugins.get<ScssPluginApi>('scss');
    const input: CascadeInput =
      args.selector !== undefined
        ? { kind: 'selector', selector: args.selector }
        : { kind: 'class', file: args.file as RepoRelPath, className: args.class ?? '' };
    const filter = {
      ...(args.pathInclude !== undefined ? { pathInclude: args.pathInclude } : {}),
      ...(args.pathExclude !== undefined ? { pathExclude: args.pathExclude } : {}),
    };
    try {
      const outcome = scss.cascadeFor(input, filter);
      if (!outcome.ok) return fail({ tool: 'css_cascade', message: outcome.message });
      const { resolution } = outcome;
      // A sheet that FAILED to parse is unscanned scope — a higher-specificity rule there could
      // change the winner, so a `certain` verdict would be a completeness lie (§3.4/§3.6). Cap every
      // winner (and the overall confidence) to `partial` and name the unscanned sheets.
      const failed = outcome.parseFailures;
      const cap = (c: Confidence): Confidence =>
        failed.length > 0 && c === 'certain' ? 'partial' : c;
      const capped: CascadeProperty[] =
        failed.length > 0
          ? resolution.properties.map((p) => ({
              ...p,
              winner: { ...p.winner, confidence: cap(p.winner.confidence) },
            }))
          : resolution.properties;
      // Tag the nested cascade rows: a property's winner ('css-winner') and losers / co-winners
      // ('css-decl-ref') are condensed before the property renderer reads them; the contributing
      // rules are 'css-rule'. The decl-ref tag is what keeps winner and loser apart now that the
      // dispatch is by tag, not by the old branch ORDER (both share value+specificity+selector).
      const properties = capped.map((p) =>
        tag('css-property', {
          ...p,
          winner: tag('css-winner', {
            ...p.winner,
            ...(p.winner.ambiguousWith !== undefined
              ? { ambiguousWith: p.winner.ambiguousWith.map((a) => tag('css-decl-ref', a)) }
              : {}),
          }),
          losers: p.losers.map((l) => tag('css-decl-ref', l)),
        }),
      );
      const notes = [
        ...resolution.notes,
        ...(failed.length > 0
          ? [
              `${failed.length} in-scope sheet(s) failed to parse and were NOT scanned — a higher-specificity rule there could change the winner; confidence capped to partial: ${failed.map((f) => f.file).join(', ')}`,
            ]
          : []),
      ];
      // Verdict-before-bulk (§12): target/confidence/notes/properties FIRST, the (larger,
      // re-fetchable) `rules` contributor list LAST, so the char-cap only ever truncates bulk.
      return ok({
        target: outcome.target,
        ...(outcome.owningFile !== undefined ? { file: outcome.owningFile } : {}),
        confidence: cap(resolution.confidence),
        ...(notes.length > 0 ? { notes } : {}),
        properties,
        scanned: { sheets: outcome.scannedSheets },
        rules: resolution.rules.map((r) => tag('css-rule', r)),
        ...(failed.length > 0 ? { parseFailures: failed.map((f) => tag('parse-failure', f)) } : {}),
      });
    } catch (thrown) {
      return failFromThrown('scss', thrown);
    }
  },
});
