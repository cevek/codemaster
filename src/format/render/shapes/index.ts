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

/** Tags whose form carries NO verbatim proof body (a name-token span is a location, members are
 *  `name: type`, a list row is locations) — so they collapse at `full` too, instead of exploding
 *  into multi-line blocks. Proof-bearing tags (symbol+decl body, …) pass through unchanged at full
 *  (the existing behavior), so this changes full output ONLY for the listed non-proof forms. */
export const COLLAPSE_AT_FULL: ReadonlySet<ShapeTag> = new Set<ShapeTag>([
  'type-member',
  'type-ref',
  'bare-span',
  'list-entry',
  'endpoint-card',
  'typecheck-clean',
  'touched-stat',
  'i18n-unused-key',
  'i18n-def',
  'i18n-usage',
  'i18n-missing-per-key',
  'i18n-missing-usage',
]);
