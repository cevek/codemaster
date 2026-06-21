// The shape registry — tag → renderer. Exhaustive over `ShapeTag` (a `Record<ShapeTag, …>`),
// so a NEW tag with no renderer is a COMPILE error (the first half of the coverage guard). Each
// per-domain file owns its renderers; this file just wires them, so the wave-2 density tracks
// edit their domain file without serializing on one giant condense.

import type { ShapeTag } from '../../../common/shape-tag/tag.ts';
import type { ShapeRenderer } from './types.ts';
import * as ts from './ts.ts';
import * as diag from './diagnostics.ts';
import * as mut from './mutating.ts';
import * as i18n from './i18n.ts';
import * as scss from './scss.ts';
import * as rq from './react-query.ts';
import * as list from './list.ts';

export const SHAPE_RENDERERS: Record<ShapeTag, ShapeRenderer> = {
  symbol: ts.symbol,
  usage: ts.usage,
  'text-hit': ts.textHit,
  'group-row': ts.groupRow,
  importer: ts.importer,
  'construction-site': ts.constructionSite,
  'unused-export': ts.unusedExport,
  'type-member': ts.typeMember,
  'type-ref': ts.typeRef,
  'unresolved-name': ts.unresolvedName,
  'bare-span': ts.bareSpan,
  'target-ref': ts.targetRef,
  'ts-diagnostic': diag.tsDiagnostic,
  'parse-failure': diag.parseFailure,
  'typecheck-clean': diag.typecheckClean,
  capture: mut.capture,
  'name-survives': mut.nameSurvives,
  'touched-stat': mut.touchedStat,
  'i18n-unused-key': i18n.i18nUnusedKey,
  'i18n-def': i18n.i18nDef,
  'i18n-usage': i18n.i18nUsage,
  'i18n-missing-per-key': i18n.i18nMissingPerKey,
  'i18n-missing-usage': i18n.i18nMissingUsage,
  'scss-class': scss.scssClass,
  'css-rule': scss.cssRule,
  'css-property': scss.cssProperty,
  'css-winner': scss.cssWinner,
  'css-decl-ref': scss.cssDeclRef,
  'css-left-behind': scss.cssLeftBehind,
  'css-coextract': scss.cssCoExtract,
  'rq-mutation': rq.rqMutation,
  'rq-edge': rq.rqEdge,
  'rq-affected': rq.rqAffected,
  'list-entry': list.listEntry,
  'endpoint-card': list.endpointCard,
};

/** Per-tag `full`-verbosity disposition. The DEFAULT is `collapse`: a list/verdict row's form
 *  carries NO verbatim proof body (a name-token span is a location, members are `name: type`, a
 *  verdict is a value), so it renders as its dense one-liner even at `full` — never an exploded
 *  multi-line `key=value` block. `verbatim` is the small opt-OUT for a proof-BEARING form whose
 *  full value IS meaningful source text. Today exactly one tag qualifies:
 *
 *  - `symbol` — carries `decl`, a span whose verbatim text is the declaration BODY (the "show me
 *    the code" payload of find_definition / find_usages' definition / search_symbol). It is also
 *    FORCED verbatim: the `symbol` renderer reads `decl` as a pre-condensed STRING, so collapsing
 *    it at full (where `decl` is a verbatim span OBJECT) would yield `[object Object]` and drop the
 *    body. Every other tag's value is structural (locations / type-strings / verdicts / counts) —
 *    exactly the noise §12 collapses.
 *
 *  EXHAUSTIVE over `ShapeTag` (a `Record`, not a Set) — so a NEW tag with no entry is a COMPILE
 *  error, the second half of the coverage guard (SHAPE_RENDERERS is the first). This is what keeps
 *  the density regression from recurring: a new row shape cannot silently default into the
 *  exploder — it must be classified, and the default it inherits when classified is `collapse`. */
export const FULL_DISPOSITION: Record<ShapeTag, 'collapse' | 'verbatim'> = {
  symbol: 'verbatim',
  usage: 'collapse',
  'text-hit': 'collapse',
  'group-row': 'collapse',
  importer: 'collapse',
  'construction-site': 'collapse',
  'unused-export': 'collapse',
  'type-member': 'collapse',
  'type-ref': 'collapse',
  'unresolved-name': 'collapse',
  'bare-span': 'collapse',
  'target-ref': 'collapse',
  'ts-diagnostic': 'collapse',
  'parse-failure': 'collapse',
  capture: 'collapse',
  'name-survives': 'collapse',
  'typecheck-clean': 'collapse',
  'touched-stat': 'collapse',
  'i18n-unused-key': 'collapse',
  'i18n-def': 'collapse',
  'i18n-usage': 'collapse',
  'i18n-missing-per-key': 'collapse',
  'i18n-missing-usage': 'collapse',
  'scss-class': 'collapse',
  'css-rule': 'collapse',
  'css-property': 'collapse',
  'css-winner': 'collapse',
  'css-decl-ref': 'collapse',
  'css-left-behind': 'collapse',
  'css-coextract': 'collapse',
  'rq-mutation': 'collapse',
  'rq-edge': 'collapse',
  'rq-affected': 'collapse',
  'list-entry': 'collapse',
  'endpoint-card': 'collapse',
};
