// Renderers for the ts read-side row shapes (find_usages / find_definition / search_symbol
// / construction_sites / impact / expand_type / importers_of / find_unused_exports). Each
// turns one tagged row into its dense one-liner; condense.ts has already condensed the row's
// child spans (to `file:line:col` strings at terse/normal). The id already carries
// name + file:line:col, so keyed name/span fields are pure repetition and are dropped.

import type { JsonValue } from '../../../core/json.ts';
import type { ShapeRenderer } from './types.ts';
import { asArray, confTail, flat, isObject, spanLoc, usageDeco } from './helpers.ts';
import { spanLocOnly, spanTextOf } from './span-text.ts';

/** SymbolView: { id, name, kind, span, decl?, container?, callable? }. The id encodes
 *  name + file:line:col and `span` is the name-token (== name) — both redundant, dropped.
 *  `callable` is ignored (it only feeds impact's dynamic-boundary check). `decl` condenses to
 *  a bare loc at terse (no header) and `loc · <first line>` at normal — the header rides a
 *  continuation line, never the redundant loc again. Covers find_usages' single `definition`
 *  (which also carries `callable` — the old key-set branches missed it → it exploded).
 *
 *  COLLAPSE disposition (FULL_DISPOSITION): the decl-BODY proof path is the renderSource
 *  interception (find_definition / source, render-result.ts) which fires BEFORE condense, so
 *  this renderer only ever runs on a no-body symbol-REF (find_usages.definition,
 *  search_symbol.matches, mergedDeclarations) — a compact `id · kind` line at every verbosity.
 *  At full, condense leaves a present `decl` as a verbatim span OBJECT, so the header is built
 *  via `spanTextOf` (never `String(obj)` → `[object Object]`) — a future decl-bearing symbol-row
 *  that reached condense would still surface `loc · firstline`, never a silently-dropped body. */
export const symbol: ShapeRenderer = (v) => {
  const container = v['container'] !== undefined ? ` in ${String(v['container'])}` : '';
  const header = declHeader(v['decl']);
  return `${String(v['id'])} · ${String(v['kind'])}${container}${header}`;
};

/** The decl continuation line — `\n  <first line of the declaration>` — or '' when absent.
 *  `decl` is an already-condensed STRING at terse/normal (`loc` / `loc · text`) and a verbatim
 *  span OBJECT at full; both yield the body's first line without the redundant loc. */
function declHeader(decl: JsonValue | undefined): string {
  if (decl === undefined) return '';
  const text = isObject(decl) ? spanTextOf(decl) : declTextOf(String(decl));
  return text.length > 0 ? `\n  ${text}` : '';
}

/** First line of a condensed-string decl (`loc · <first line>`) — the part after the separator;
 *  '' for a bare `loc` (terse, no text). */
function declTextOf(declStr: string): string {
  const sep = declStr.indexOf(' · ');
  return sep >= 0 ? declStr.slice(sep + 3) : '';
}

/** UsageView: { span, role, confidence } (+ optional program/decls decorations). `role` is
 *  rendered only when present — a single-role filter HOISTS it to a `role=` header and drops it
 *  per-row (find_usages), so the line would otherwise end in `· undefined`. */
export const usage: ShapeRenderer = (v) => {
  const role = v['role'] !== undefined ? ` · ${String(v['role'])}` : '';
  return `${spanLoc(v['span'])}${role}${confTail(v['confidence'])}${usageDeco(v)}`;
};

/** Text-only hit (§ text-overlay): { span, confidence:'unresolved' } — no role (the text scanner
 *  can't claim an AST concept). The `unresolved` confidence is stated ONCE in the section note
 *  (the whole section is identity-unproven by definition), so the row is just its location. */
export const textHit: ShapeRenderer = (v) => spanLoc(v['span']);

/** GroupRow (enclosing rollup): the id carries name + file:line:col, so terse collapses to
 *  one line; the explicit columns exist for relational projection. `site` (a representative
 *  reference span inside the encloser) is present in find_usages, stripped by impact. */
export const groupRow: ShapeRenderer = (v) => {
  const exp = v['exported'] === true ? ' · exported' : '';
  const ref = v['site'] !== undefined ? ` · ref ${spanLoc(v['site'])}` : '';
  return `${String(v['id'])} · ${String(v['kind'])} · x${String(v['count'])} (${String(v['roles'])})${exp}${confTail(v['confidence'])}${ref}${usageDeco(v)}`;
};

/** ImporterRow: { at, imports }. */
export const importer: ShapeRenderer = (v) => `${String(v['at'])} · ${String(v['imports'])}`;

/** SUBTREE ImporterRow: { at, scope, target, imports } — scope (external=blocker / internal) plus
 *  the specific file under the tree this importer pulls (per-row, varies). */
export const subtreeImporter: ShapeRenderer = (v) =>
  `${String(v['at'])} · ${String(v['scope'])} → ${String(v['target'])} · ${String(v['imports'])}`;

/** SUBTREE UnconfirmedRef: { at, spec, reason } — an unresolvable spec lexically under the tree,
 *  flagged (not raw-matched). */
export const subtreeUnconfirmed: ShapeRenderer = (v) =>
  `${String(v['at'])} · ${String(v['spec'])} · ${String(v['reason'])}`;

/** ConstructionSiteView: { span, confidence, encloser:{id,kind,exported,…}, note? }. The
 *  encloser sub-object re-prints what `encloser.id` encodes — fold to `in <id> (kind[, exported])`. */
export const constructionSite: ShapeRenderer = (v) => {
  const enc = v['encloser'];
  if (!isObject(enc)) return v;
  const exp = enc['exported'] === true ? ', exported' : '';
  const note = v['note'] !== undefined ? ` · ${flat(v['note'])}` : '';
  return `${spanLoc(v['span'])} · in ${String(enc['id'])} (${String(enc['kind'])}${exp})${confTail(v['confidence'])}${note}`;
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

/** A bare single-span object (find_missing `dynamicUsages: {span}[]`): the `span=` key is noise.
 *  The span's verbatim TEXT is the evidence here — the dynamic `t(`…`)` template-literal key
 *  expression that proves the call is dynamic — so it MUST survive at full. Render `loc · text`:
 *  `spanTextOf` reads the (single-line) template from the condensed string (normal) or the verbatim
 *  span object (full); terse carries no text → loc only. */
export const bareSpan: ShapeRenderer = (v) => {
  const text = spanTextOf(v['span']);
  return text.length > 0 ? `${spanLocOnly(v['span'])} · ${text}` : spanLocOnly(v['span']);
};

/** target-ref — the identity a type-aware op reports FOR. impact's seed { id, name, kind }
 *  (id carries name + loc → `id · kind`); construction_sites' { kind, name, span } (no id →
 *  `kind name @ loc`). Both previously exploded into a `target:` block. */
export const targetRef: ShapeRenderer = (v) => {
  if (v['id'] !== undefined) return `${String(v['id'])} · ${String(v['kind'])}`;
  const loc = v['span'] !== undefined ? ` @ ${spanLoc(v['span'])}` : '';
  return `${String(v['kind'])} ${String(v['name'])}${loc}`;
};

/** discrimination-target — the union T discrimination_sites reports FOR: { kind, name, span,
 *  discriminants:[{name,domain[]}] }. Fold the discriminant domains onto one line. */
export const discriminationTarget: ShapeRenderer = (v) => {
  const loc = v['span'] !== undefined ? ` @ ${spanLoc(v['span'])}` : '';
  const discs = asArray(v['discriminants'])
    .map((d) =>
      isObject(d)
        ? `${String(d['name'])}:{${asArray(d['domain']).map(String).join(',')}}`
        : String(d),
    )
    .join(' ');
  return `${String(v['kind'])} ${String(v['name'])}${loc}${discs !== '' ? ` · discriminants ${discs}` : ''}`;
};

/** discrimination-site — a switch/if-chain discriminating on T: { kind, span, scrutinee,
 *  discriminant, confidence, covers[], missing[], hasDefault, encloser:{id}, note? }. The
 *  MISSING set (domain − covers) is the load-bearing "widen-T gap", so it leads over the note. */
export const discriminationSite: ShapeRenderer = (v) => {
  const enc = v['encloser'];
  if (!isObject(enc)) return v;
  const covers = asArray(v['covers']).map(String);
  const missing = asArray(v['missing']).map(String);
  const cov = covers.length > 0 ? ` · covers[${covers.join(',')}]` : '';
  const miss = missing.length > 0 ? ` · MISSING[${missing.join(',')}]` : '';
  const def = v['hasDefault'] === true ? ' · default' : '';
  const note = v['note'] !== undefined ? ` · ${flat(v['note'])}` : '';
  return `${spanLoc(v['span'])} · ${String(v['kind'])} ${String(v['scrutinee'])} on ${String(v['discriminant'])}${cov}${miss}${def} · in ${String(enc['id'])}${confTail(v['confidence'])}${note}`;
};
