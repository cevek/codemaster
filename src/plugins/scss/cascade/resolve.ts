// Resolve the cascade for a target class from its CONTRIBUTIONS across sheets (spec-css-
// cascade-op): order every contributing rule by specificity, and decide the WINNING
// declaration per property (`!important` > specificity > later source order WITHIN a file).
//
// Honesty (§3, §19): a winner is `certain` only when it is a same-module, unconditional,
// context-free, statically-valued declaration with no unbreakable tie. CSS-module classes
// are per-file scoped, so a cross-file (or `:global`) contributor is named and ordered but
// stays `partial` — we cannot prove a same-named class in another module is the same element.
// A state/attribute/descendant/`@media`/interpolated/computed contributor is likewise
// `partial`. A partial winner is still a NAMED winner — never dropped.

import type { Confidence, Span } from '../../../core/span.ts';
import type { RepoRelPath } from '../../../core/brands.ts';
import { worstOf } from '../../../common/confidence/worst-of.ts';
import {
  compareSpecificity,
  formatSpecificity,
  specificityEqual,
  type ConditionReason,
} from './specificity.ts';
import type { CascadeContribution, CascadeDecl } from './rules.ts';

type CascadeDeclRef = {
  value: string;
  important: boolean;
  file: RepoRelPath;
  selector: string;
  /** The (a,b,c) specificity, preformatted (`"0,2,0"`) for dense output + sql projection. */
  specificity: string;
  span: Span;
};

type CascadeWinner = CascadeDeclRef & {
  confidence: Confidence;
  note?: string;
  /** Co-winners we cannot order against the winner (a cross-module specificity tie). */
  ambiguousWith?: CascadeDeclRef[];
};

export type CascadeProperty = { prop: string; winner: CascadeWinner; losers: CascadeDeclRef[] };

type CascadeRuleView = {
  file: RepoRelPath;
  selector: string;
  specificity: string;
  conditions: ConditionReason[];
  atContext: string[];
  global: boolean;
  interpolated: boolean;
  requiresExtraClasses: string[];
  crossModule: boolean;
  span: Span;
  declarations: { prop: string; value: string; important: boolean }[];
};

export type CascadeResolution = {
  /** Per-property verdict — emitted FIRST so the §12 char-cap can only truncate the bulk. */
  properties: CascadeProperty[];
  /** Every contributing rule, ordered by specificity desc — the (re-fetchable) bulk. */
  rules: CascadeRuleView[];
  confidence: Confidence;
  notes: string[];
};

type Entry = { c: CascadeContribution; d: CascadeDecl };

export function resolveCascade(
  target: string,
  owningFile: RepoRelPath | undefined,
  contributions: readonly CascadeContribution[],
): CascadeResolution {
  const files = new Set(contributions.map((c) => c.file));
  // In file+class mode the owner is given; in selector mode infer it ONLY when every
  // contribution lives in one sheet (then that sheet is the module) — otherwise the module
  // is unknown and everything is treated cross-module (conservative — §3).
  const owner = owningFile ?? (files.size === 1 ? [...files][0] : undefined);
  const isCrossModule = (c: CascadeContribution): boolean =>
    owner === undefined || c.file !== owner;

  const rules = [...contributions]
    .sort(
      (a, b) => -compareSpecificity(a.specificity, b.specificity) || a.file.localeCompare(b.file),
    )
    .map(
      (c): CascadeRuleView => ({
        file: c.file,
        selector: c.selector,
        specificity: formatSpecificity(c.specificity),
        conditions: c.conditions,
        atContext: c.atContext,
        global: c.global,
        interpolated: c.interpolated,
        requiresExtraClasses: c.requiresExtraClasses,
        crossModule: isCrossModule(c),
        span: c.selectorSpan,
        declarations: c.declarations.map((d) => ({
          prop: d.prop,
          value: d.value,
          important: d.important,
        })),
      }),
    );

  const byProp = new Map<string, Entry[]>();
  for (const c of contributions) {
    for (const d of c.declarations) {
      const list = byProp.get(d.prop) ?? [];
      list.push({ c, d });
      byProp.set(d.prop, list);
    }
  }

  const properties: CascadeProperty[] = [];
  for (const [prop, entries] of byProp) {
    entries.sort(priorityCmp);
    const top = entries[0];
    if (top === undefined) continue;
    const rest = entries.slice(1);
    const ambiguous = rest.filter((e) => ambiguousTie(top, e));
    const { confidence, note } = winnerConfidence(top, owner, ambiguous.length > 0);
    properties.push({
      prop,
      winner: {
        ...declRef(top),
        confidence,
        ...(note !== undefined ? { note } : {}),
        ...(ambiguous.length > 0 ? { ambiguousWith: ambiguous.map(declRef) } : {}),
      },
      losers: rest.filter((e) => !ambiguous.includes(e)).map(declRef),
    });
  }
  properties.sort((a, b) => a.prop.localeCompare(b.prop));

  // An empty answer is NOT `certain`: the syntactic scan over only the indexed sheets can't
  // prove completeness (a dynamic/`:global`/unindexed sheet could still target the class), so
  // "nothing found" is honest uncertainty (§3.4), not a proven absence.
  const confidence =
    properties.length === 0 ? 'partial' : worstOf(properties.map((p) => p.winner.confidence));
  return {
    properties,
    rules,
    confidence,
    notes: buildNotes(target, owner, contributions, rules),
  };
}

/** Ascending comparator with the WINNER first: `!important` beats normal; then higher
 *  specificity; then — within one file only — the later declaration (source order). A
 *  cross-file tie is left unordered (0) and surfaces as `ambiguousWith`. */
function priorityCmp(a: Entry, b: Entry): number {
  if (a.d.important !== b.d.important) return a.d.important ? -1 : 1;
  const spec = compareSpecificity(a.c.specificity, b.c.specificity);
  if (spec !== 0) return -spec;
  if (a.c.file === b.c.file) return b.d.pos - a.d.pos;
  return 0;
}

function ambiguousTie(top: Entry, e: Entry): boolean {
  return (
    top.d.important === e.d.important &&
    specificityEqual(top.c.specificity, e.c.specificity) &&
    top.c.file !== e.c.file
  );
}

function declRef(e: Entry): CascadeDeclRef {
  return {
    value: e.d.value,
    important: e.d.important,
    file: e.c.file,
    selector: e.c.selector,
    specificity: formatSpecificity(e.c.specificity),
    span: e.d.span,
  };
}

const CONDITION_TEXT: Record<ConditionReason, string> = {
  descendant: 'contextual — requires an ancestor/sibling match',
  'pseudo-class': 'state/positional pseudo-class (e.g. :hover) — applies only then',
  attribute: 'attribute selector — applies only when the attribute is present',
  negation: ':not() narrows which elements match',
  'pseudo-element': 'styles a pseudo-element (::before/::after), not the element itself',
  'element-type': 'qualified by an element type — applies only to that element',
  id: 'qualified by an #id — applies only to the element bearing it',
};

function winnerConfidence(
  top: Entry,
  owner: RepoRelPath | undefined,
  ambiguous: boolean,
): { confidence: Confidence; note?: string } {
  const reasons: string[] = [];
  if (ambiguous)
    reasons.push('cross-module specificity tie — source order across modules is unknown');
  if (top.c.global) reasons.push('reached via :global — not module-scoped');
  else if (owner === undefined || top.c.file !== owner) {
    reasons.push(
      'cross-module — CSS-module classes are per-file scoped; cannot prove it cascades with the target',
    );
  }
  for (const cond of top.c.conditions) reasons.push(CONDITION_TEXT[cond]);
  if (top.c.atContext.length > 0) reasons.push(`applies only under ${top.c.atContext.join(' / ')}`);
  if (top.c.interpolated)
    reasons.push('selector uses interpolation — specificity is a lower bound');
  if (top.c.requiresExtraClasses.length > 0) {
    reasons.push(`element must also carry .${top.c.requiresExtraClasses.join(', .')}`);
  }
  if (top.d.computed)
    reasons.push('value is computed (Sass variable/interpolation) — reported verbatim');
  if (reasons.length === 0) return { confidence: 'certain' };
  return { confidence: 'partial', note: reasons.join('; ') };
}

function buildNotes(
  target: string,
  owner: RepoRelPath | undefined,
  contributions: readonly CascadeContribution[],
  rules: readonly CascadeRuleView[],
): string[] {
  const notes: string[] = [];
  if (contributions.length === 0) {
    notes.push(`no rule's subject targets .${target} in the scanned sheets`);
    return notes;
  }
  if (rules.some((r) => r.crossModule)) {
    notes.push(
      'cross-module contributors are syntactic only: CSS-module class names are per-file scoped, so a same-named class in another sheet is a DIFFERENT runtime class unless composed/:global/applied to the same element (§19) — named & ordered, but partial.',
    );
  }
  if (owner === undefined && contributions.length > 0) {
    notes.push(
      'no owning module given (selector mode over >1 sheet) — every contributor treated cross-module.',
    );
  }
  return notes;
}
