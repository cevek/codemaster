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
import * as react from './react.ts';
import * as rq from './react-query.ts';
import * as trace from './trace.ts';
import * as list from './list.ts';

export const SHAPE_RENDERERS: Record<ShapeTag, ShapeRenderer> = {
  symbol: ts.symbol,
  usage: ts.usage,
  'text-hit': ts.textHit,
  'group-row': ts.groupRow,
  importer: ts.importer,
  'subtree-importer': ts.subtreeImporter,
  'subtree-unconfirmed': ts.subtreeUnconfirmed,
  'construction-site': ts.constructionSite,
  'unused-export': ts.unusedExport,
  'phantom-dep': ts.phantomDep,
  'type-member': ts.typeMember,
  'type-ref': ts.typeRef,
  'unresolved-name': ts.unresolvedName,
  'bare-span': ts.bareSpan,
  'target-ref': ts.targetRef,
  'discrimination-target': ts.discriminationTarget,
  'discrimination-site': ts.discriminationSite,
  'member-usage': ts.memberUsage,
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
  'unused-prop': react.unusedProp,
  'rq-mutation': rq.rqMutation,
  'rq-edge': rq.rqEdge,
  'rq-affected': rq.rqAffected,
  'trace-hop': trace.traceHop,
  'list-entry': list.listEntry,
  'endpoint-card': list.endpointCard,
  'symbol-catalogue-group': list.symbolCatalogueGroup,
};

/** Per-tag `full`-verbosity disposition. The DEFAULT is `collapse`: a list/verdict row's form
 *  carries NO verbatim proof body (a name-token span is a location, members are `name: type`, a
 *  verdict is a value), so it renders as its dense one-liner even at `full` — never an exploded
 *  multi-line `key=value` block. `verbatim` is the small opt-OUT for a proof-BEARING form whose
 *  full value IS meaningful source text — the renderer is SKIPPED and the raw object passes to
 *  render-dense (so it explodes unless an upstream interception reshapes it first).
 *
 *  **No tag currently elects `verbatim`.** The "show me the code" payload (a symbol's declaration
 *  BODY) is delivered by the renderSource COMPACT-BODY interception in render-result.ts, which
 *  fires for find_definition / source BEFORE condense runs — so a decl-bearing symbol never reaches
 *  this disposition. The symbol-tagged rows that DO reach condense (find_usages' `definition`,
 *  search_symbol's `matches`, `mergedDeclarations`) are name-token-only REFS with no body, so
 *  `verbatim` only ever exploded them; `symbol` is therefore `collapse` (its renderer is robust to a
 *  full-mode decl OBJECT, surfacing `loc · firstline`, so the collapse can never silently drop a
 *  body). The `verbatim` branch in `condense.ts` is retained as infrastructure for a future
 *  proof-bearing form whose body is NOT routed through a renderSource-style interception.
 *
 *  EXHAUSTIVE over `ShapeTag` (a `Record`, not a Set) — so a NEW tag with no entry is a COMPILE
 *  error, the second half of the coverage guard (SHAPE_RENDERERS is the first). This is what keeps
 *  the density regression from recurring: a new row shape cannot silently default into the
 *  exploder — it must be classified, and the default it inherits when classified is `collapse`. */
export const FULL_DISPOSITION: Record<ShapeTag, 'collapse' | 'verbatim'> = {
  symbol: 'collapse',
  usage: 'collapse',
  'text-hit': 'collapse',
  'group-row': 'collapse',
  importer: 'collapse',
  'subtree-importer': 'collapse',
  'subtree-unconfirmed': 'collapse',
  'construction-site': 'collapse',
  'unused-export': 'collapse',
  'phantom-dep': 'collapse',
  'type-member': 'collapse',
  'type-ref': 'collapse',
  'unresolved-name': 'collapse',
  'bare-span': 'collapse',
  'target-ref': 'collapse',
  'discrimination-target': 'collapse',
  'discrimination-site': 'collapse',
  'member-usage': 'collapse',
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
  'unused-prop': 'collapse',
  'rq-mutation': 'collapse',
  'rq-edge': 'collapse',
  'rq-affected': 'collapse',
  'trace-hop': 'collapse',
  'list-entry': 'collapse',
  'endpoint-card': 'collapse',
  'symbol-catalogue-group': 'collapse',
};
