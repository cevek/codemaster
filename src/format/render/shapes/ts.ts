// Renderers for the ts read-side row shapes (find_usages / find_definition / search_symbol
// / construction_sites / impact / expand_type / importers_of / find_unused_exports). Each
// turns one tagged row into its dense one-liner; condense.ts has already condensed the row's
// child spans (to `file:line:col` strings at terse/normal). The id already carries
// name + file:line:col, so keyed name/span fields are pure repetition and are dropped.

import type { ShapeRenderer } from './types.ts';
import { asArray, confTail, flat, isObject, spanLoc, usageDeco } from './helpers.ts';

/** SymbolView: { id, name, kind, span, decl?, container?, callable? }. The id encodes
 *  name + file:line:col and `span` is the name-token (== name) — both redundant, dropped.
 *  `callable` is ignored (it only feeds impact's dynamic-boundary check). `decl` condenses to
 *  a bare loc at terse (no header) and `loc · <first line>` at normal — the header rides a
 *  continuation line, never the redundant loc again. Covers find_usages' single `definition`
 *  (which also carries `callable` — the old key-set branches missed it → it exploded). */
export const symbol: ShapeRenderer = (v) => {
  const container = v['container'] !== undefined ? ` in ${String(v['container'])}` : '';
  const declStr = v['decl'] !== undefined ? String(v['decl']) : '';
  const sep = declStr.indexOf(' · ');
  const header = sep >= 0 ? `\n  ${declStr.slice(sep + 3)}` : '';
  return `${String(v['id'])} · ${String(v['kind'])}${container}${header}`;
};

/** UsageView: { span, role, confidence } (+ optional program/decls decorations). */
export const usage: ShapeRenderer = (v) =>
  `${String(v['span'])} · ${String(v['role'])}${confTail(v['confidence'])}${usageDeco(v)}`;

/** Text-only hit (§ text-overlay): { span, confidence:'unresolved' } — no role (the text
 *  scanner can't claim an AST concept). */
export const textHit: ShapeRenderer = (v) => `${String(v['span'])} · ${String(v['confidence'])}`;

/** GroupRow (enclosing rollup): the id carries name + file:line:col, so terse collapses to
 *  one line; the explicit columns exist for relational projection. `site` (a representative
 *  reference span inside the encloser) is present in find_usages, stripped by impact. */
export const groupRow: ShapeRenderer = (v) => {
  const exp = v['exported'] === true ? ' · exported' : '';
  const ref = v['site'] !== undefined ? ` · ref ${String(v['site'])}` : '';
  return `${String(v['id'])} · ${String(v['kind'])} · x${String(v['count'])} (${String(v['roles'])})${exp}${confTail(v['confidence'])}${ref}${usageDeco(v)}`;
};

/** ImporterRow: { at, imports }. */
export const importer: ShapeRenderer = (v) => `${String(v['at'])} · ${String(v['imports'])}`;

/** ConstructionSiteView: { span, confidence, encloser:{id,kind,exported,…}, note? }. The
 *  encloser sub-object re-prints what `encloser.id` encodes — fold to `in <id> (kind[, exported])`. */
export const constructionSite: ShapeRenderer = (v) => {
  const enc = v['encloser'];
  if (!isObject(enc)) return v;
  const exp = enc['exported'] === true ? ', exported' : '';
  const note = v['note'] !== undefined ? ` · ${flat(v['note'])}` : '';
  return `${String(v['span'])} · in ${String(enc['id'])} (${String(enc['kind'])}${exp})${confTail(v['confidence'])}${note}`;
};

/** UnusedExportView: { name, kind, file, span, symbol, confidence, note? }. The `symbol` id
 *  carries name + file:line:col and `span` repeats the loc — keep the chainable id + kind. */
export const unusedExport: ShapeRenderer = (v) => {
  const note = v['note'] !== undefined ? ` · ${flat(v['note'])}` : '';
  return `${String(v['symbol'])} · ${String(v['kind'])}${confTail(v['confidence'])}${note}`;
};

/** MemberView: { name, optional, type, inherited?, members? }. The type carries spaces so it
 *  never inlines as k=v; render `name[?]: type`. A member WITH nested members (depth>1) — which
 *  the old leaf branch missed, so it exploded — keeps the head then its (already-condensed)
 *  sub-members indented beneath, as a multi-line string (no bare k=v at depth). Collapses at full
 *  too: a member carries no verbatim proof body (just `name: type`). */
export const typeMember: ShapeRenderer = (v) => {
  const opt = v['optional'] === true ? '?' : '';
  const inh = v['inherited'] === true ? ' (inherited)' : '';
  const head = `${String(v['name'])}${opt}: ${String(v['type'])}${inh}`;
  const nested = asArray(v['members']);
  if (nested.length === 0) return head;
  const indented = nested
    .map((m) =>
      String(m)
        .split('\n')
        .map((l) => `  ${l}`)
        .join('\n'),
    )
    .join('\n');
  return `${head}\n${indented}`;
};

/** TypeRef (schema; also nested in an EndpointCard's query/body/response): { text, span,
 *  confidence }. `text` is a type string (spaces) → never inlines. Collapses at full (the span
 *  is a location, not a proof body). */
export const typeRef: ShapeRenderer = (v) =>
  `${spanLoc(v['span'])} · ${flat(v['text'])}${confTail(v['confidence'])}`;

/** find_usages symbols-mode unresolved row: { name, reason }. */
export const unresolvedName: ShapeRenderer = (v) => `${String(v['name'])} · ${flat(v['reason'])}`;

/** A bare single-span object (e.g. find_missing `dynamicUsages: {span}[]`): the `span=` key is
 *  noise — render just the clickable location. Collapses at full. */
export const bareSpan: ShapeRenderer = (v) => spanLoc(v['span']);

/** target-ref — the identity a type-aware op reports FOR. impact's seed { id, name, kind }
 *  (id carries name + loc → `id · kind`); construction_sites' { kind, name, span } (no id →
 *  `kind name @ loc`). Both previously exploded into a `target:` block. */
export const targetRef: ShapeRenderer = (v) => {
  if (v['id'] !== undefined) return `${String(v['id'])} · ${String(v['kind'])}`;
  const loc = v['span'] !== undefined ? ` @ ${spanLoc(v['span'])}` : '';
  return `${String(v['kind'])} ${String(v['name'])}${loc}`;
};
