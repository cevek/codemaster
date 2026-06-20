// Verbosity-driven span condensation (§12). The tool must return an ANSWER, not
// material for one: by default a span renders as a clickable `file:line:col` —
// verbatim proof text is opt-in (`full`), because for list-shaped answers it is 90%
// of the tokens and 0% of the signal. The agent can always re-fetch one symbol's
// proof via find_definition/expand_type with verbosity=full.
//
//   terse  → "file:line:col"
//   normal → "file:line:col · first line of the span text (≤60ch)"
//   full   → the span object untouched (verbatim proof text)

import type { JsonValue } from '../../core/json.ts';
import type { Verbosity } from '../../core/result.ts';

const NORMAL_TEXT_CAP = 60;

export function condenseSpans(value: JsonValue, verbosity: Verbosity): JsonValue {
  if (verbosity === 'full') return value;
  if (isJsonArray(value)) return value.map((v) => condenseSpans(v, verbosity));
  if (typeof value === 'object' && value !== null) {
    const v = value as Record<string, JsonValue>;
    if (looksLikeSpan(v)) return renderSpanLine(v, verbosity);
    const out: Record<string, JsonValue> = {};
    for (const [key, child] of Object.entries(v)) out[key] = condenseSpans(child, verbosity);
    // Collapse one-fact rows at terse AND normal (full returned above). At normal the condensed
    // spans already carry their first-line text, so the same collapse yields a richer one-liner —
    // a `normal` list answer is compact lines, not multi-line key=value blocks.
    return collapseKnownShape(out);
  }
  return value;
}

/** Well-known one-fact objects collapse to ONE line — the id already carries name +
 *  file:line:col, so `{id,name,kind,span}` as keyed fields is pure repetition. Runs at terse
 *  AND normal; at normal the condensed spans carry their first-line text, so the same collapse
 *  yields a richer line (+ the decl header for a SymbolView). Unknown shapes pass through. */
function collapseKnownShape(v: Record<string, JsonValue>): JsonValue {
  const keys = Object.keys(v).sort().join(',');
  // Optional provenance decorations carried ONLY on usage rows (Task G program · merge decls).
  // They append to the rendered line and are stripped from the key set so the base UsageView /
  // GroupRow branches still match — a single-program non-merge row carries neither and is unchanged.
  // FRAGILE COUPLING (R2): the strip is keyed on field NAMES, applied before EVERY branch below — so
  // a future non-usage shape with a literal `program`/`programs`/`decls` data field would silently
  // lose it from its key set here and mis-collapse. These names are reserved for usage decorations;
  // a new shape needing one of them must namespace it (the deco only fires when `usageDeco` matched).
  const deco = usageDeco(v);
  const coreKeys =
    deco === ''
      ? keys
      : Object.keys(v)
          .filter((k) => k !== 'program' && k !== 'programs' && k !== 'decls')
          .sort()
          .join(',');
  // SymbolView: { id, name, kind, span(condensed), decl?(condensed), container? }. The id already
  // carries name + file:line:col, and `span` is the name-token (text === name) — both redundant,
  // dropped. `decl` condenses to a bare `loc` at terse (→ no header) and `loc · <first line>` at
  // normal — pull that header onto a continuation line (never the redundant loc again).
  if (
    keys === 'id,kind,name,span' ||
    keys === 'container,id,kind,name,span' ||
    keys === 'decl,id,kind,name,span' ||
    keys === 'container,decl,id,kind,name,span'
  ) {
    const container = v['container'] !== undefined ? ` in ${String(v['container'])}` : '';
    const declStr = v['decl'] !== undefined ? String(v['decl']) : '';
    const sep = declStr.indexOf(' · ');
    const header = sep >= 0 ? `\n  ${declStr.slice(sep + 3)}` : '';
    return `${String(v['id'])} · ${String(v['kind'])}${container}${header}`;
  }
  // UsageView: { span(condensed), role, confidence } (+ optional program/decls decorations).
  if (coreKeys === 'confidence,role,span') {
    const confidence = v['confidence'] === 'certain' ? '' : ` · ${String(v['confidence'])}`;
    return `${String(v['span'])} · ${String(v['role'])}${confidence}${deco}`;
  }
  // Text-only hit (§ text-overlay): { span(condensed), confidence:'unresolved' } — no role,
  // because role is an AST concept the text scanner can't claim.
  if (keys === 'confidence,span') {
    return `${String(v['span'])} · ${String(v['confidence'])}`;
  }
  // GroupRow (enclosing rollup): { id, name, file, line, col, kind, count, roles,
  // exported, confidence, site? } — the id already carries name + file:line:col, so terse
  // collapses to one line; the explicit columns exist for relational projection (§3). The
  // `site` (a representative reference span inside the encloser) is present in `find_usages`
  // output and absent in `impact`'s closure listing (stripped via `omitGroupSite`) — a
  // separate key set, so both render terse instead of dropping to verbose key=value blocks.
  if (
    coreKeys === 'col,confidence,count,exported,file,id,kind,line,name,roles' ||
    coreKeys === 'col,confidence,count,exported,file,id,kind,line,name,roles,site'
  ) {
    const conf = v['confidence'] === 'certain' ? '' : ` · ${String(v['confidence'])}`;
    const exp = v['exported'] === true ? ' · exported' : '';
    // The encloser's `id` anchors at its NAME token; `site` is WHERE a reference actually is
    // (a distinct location) — surfaced so the group is proof-carrying at the reference level.
    const ref = v['site'] !== undefined ? ` · ref ${String(v['site'])}` : '';
    return `${String(v['id'])} · ${String(v['kind'])} · x${String(v['count'])} (${String(v['roles'])})${exp}${conf}${ref}${deco}`;
  }
  // ImporterRow: { at, imports }
  if (keys === 'at,imports') {
    return `${String(v['at'])} · ${String(v['imports'])}`;
  }
  // Capture row (a mutating-op capture-safety refusal — rename/move/extract/codemod): { at, kind,
  // detail }. `at` is the clickable file:line:col; `detail` carries spaces (never inlines). One line
  // instead of a 3-line key=value block. (typecheck.introduced is a DIFFERENT shape — file,line,message.)
  if (keys === 'at,detail,kind') {
    return `${String(v['at'])} · ${String(v['kind'])} · ${flat(v['detail'])}`;
  }
  // ConstructionSiteView (construction_sites): { span(condensed), confidence, encloser:{id,name,kind,
  // file,line,col,exported}, note? }. The encloser sub-object re-prints what `encloser.id` already
  // encodes (name + file:line:col) and the path repeats 3× — fold it to `in <id> (kind[, exported])`;
  // `certain` stays implicit. Distinct key-set: no other view carries an `encloser` field.
  if (
    (keys === 'confidence,encloser,span' || keys === 'confidence,encloser,note,span') &&
    isObject(v['encloser'])
  ) {
    const enc = v['encloser'];
    const conf = v['confidence'] === 'certain' ? '' : ` · ${String(v['confidence'])}`;
    const exp = enc['exported'] === true ? ', exported' : '';
    const note = v['note'] !== undefined ? ` · ${flat(v['note'])}` : '';
    return `${String(v['span'])} · in ${String(enc['id'])} (${String(enc['kind'])}${exp})${conf}${note}`;
  }
  // invalidations_for ResolvedMutation: { id, name, site, edges }. The data stays structured (raw
  // QueryKeyView + Spans — proof + json-mode + tests intact); only the TEXT collapses. The id carries
  // name + decl loc, so name/site drop here; the `edges (N):` tree header stays (hierarchy is real).
  if (keys === 'edges,id,name,site') {
    return { id: v['id'] ?? null, edges: v['edges'] ?? null };
  }
  // invalidations_for ResolvedInvalidation (edge): { method, key?, all, exact, narrowed, span, affects }.
  // Fold the scalar fan into one `method @span <key> [flags] · conf` line; keep the affects child.
  if (
    keys === 'affects,all,exact,key,method,narrowed,span' ||
    keys === 'affects,all,exact,method,narrowed,span'
  ) {
    const broad = v['all'] === true;
    const flags =
      (v['exact'] === true ? ' · exact' : '') + (v['narrowed'] === true ? ' · narrowed' : '');
    const key = broad ? '(all)' : summarizeQueryKey(v['key']);
    const conf = broad
      ? 'dynamic'
      : isObject(v['key'])
        ? String(v['key']['confidence'])
        : 'dynamic';
    const edge = `${String(v['method'])} @${String(v['span'])} ${key}${flags} · ${conf}`;
    return { edge, affects: v['affects'] ?? null };
  }
  // invalidations_for AffectedQuery (leaf — the row that exploded ×N): { id, name, queryKey, site,
  // confidence }. The id carries the query hook's name + decl loc; the queryKey summarizes to its
  // literal form. One line instead of a 5-line block.
  if (keys === 'confidence,id,name,queryKey,site') {
    const conf = v['confidence'] === 'certain' ? '' : ` · ${String(v['confidence'])}`;
    return `${String(v['id'])} · ${summarizeQueryKey(v['queryKey'])}${conf}`;
  }
  // UnusedExportView (find_unused_exports): { name, kind, file, span(condensed), symbol, confidence,
  // note? }. The `symbol` id already carries name + file:line:col and `span` repeats the loc — keep
  // just the chainable id + kind; `certain` implicit, the partial reason decorates the tail.
  if (
    keys === 'confidence,file,kind,name,span,symbol' ||
    keys === 'confidence,file,kind,name,note,span,symbol'
  ) {
    const conf = v['confidence'] === 'certain' ? '' : ` · ${String(v['confidence'])}`;
    const note = v['note'] !== undefined ? ` · ${flat(v['note'])}` : '';
    return `${String(v['symbol'])} · ${String(v['kind'])}${conf}${note}`;
  }
  // ScssClassView: { name, file, span(condensed), confidence } and UnusedClassView (+ note?).
  // The condensed span already carries file:line:col, so the separate `file` key is pure
  // repetition — drop it. certain confidence is the default and stays implicit (like UsageView).
  if (keys === 'confidence,file,name,span' || keys === 'confidence,file,name,note,span') {
    const conf = v['confidence'] === 'certain' ? '' : ` · ${String(v['confidence'])}`;
    const note = v['note'] !== undefined ? ` · ${String(v['note'])}` : '';
    return `${String(v['span'])} · ${String(v['name'])}${conf}${note}`;
  }
  // UnusedKeyView (i18n): { key, file, span(condensed), confidence }. The condensed span carries
  // file:line:col, so the separate `file` is dropped; `certain` stays implicit. The demote reason
  // is global (stated once as the envelope's degradedReason), never repeated per row.
  if (keys === 'confidence,file,key,span') {
    const conf = v['confidence'] === 'certain' ? '' : ` · ${String(v['confidence'])}`;
    return `${String(v['span'])} · ${String(v['key'])}${conf}`;
  }
  // i18n_lookup KeyDef: { key, locale, file, span(condensed), value }. Drop the redundant
  // `file` (the condensed span carries it). The value is FLATTENED (newlines/tabs → one space):
  // a multi-line locale value would otherwise split into orphan lines with no clickable anchor.
  if (keys === 'file,key,locale,span,value') {
    return `${String(v['span'])} · ${String(v['key'])} · ${String(v['locale'])}=${flat(v['value'])}`;
  }
  // i18n_lookup usage site: { key, span(condensed) }.
  if (keys === 'key,span') {
    return `${String(v['span'])} · ${String(v['key'])}`;
  }
  // i18n_lookup missing-per-key: { key, missingLocales[] }.
  if (keys === 'key,missingLocales') {
    const locs = Array.isArray(v['missingLocales']) ? v['missingLocales'].join(',') : '';
    return `${String(v['key'])} · missing in [${locs}]`;
  }
  // find_missing usage site: { key, span(condensed), missingLocales[] } — one row per usage,
  // the locale list folded in (never a row per missing locale).
  if (keys === 'key,missingLocales,span') {
    const locs = Array.isArray(v['missingLocales']) ? v['missingLocales'].join(',') : '';
    return `${String(v['span'])} · ${String(v['key'])} · missing in [${locs}]`;
  }
  // A bare single-span object (e.g. find_missing `dynamicUsages: {span}[]`): the `span=` key is
  // noise — render just the clickable location.
  if (keys === 'span') {
    return String(v['span']);
  }
  // TS diagnostic row (mutating-op typecheck `introduced`): { file, line, message }. `file:line`
  // is clickable; the message is flattened to one line (TS joins multi-line messages with \n, which
  // would otherwise split into unanchored lines). A 3-line block per diagnostic → one line.
  if (keys === 'file,line,message') {
    return `${String(v['file'])}:${String(v['line'])} · ${flat(v['message'])}`;
  }
  // Parse-failure row (scss/i18n `parseFailures`): { file, message }.
  if (keys === 'file,message') {
    return `${String(v['file'])} · ${flat(v['message'])}`;
  }
  // MemberView (leaf — no nested `members`): { name, optional, type, inherited? }. A union type
  // carries spaces so it never inlines as k=v; render it as the familiar `name[?]: type` instead
  // of three keyed lines. A member WITH nested members keeps the structured form (falls through).
  if (keys === 'name,optional,type' || keys === 'inherited,name,optional,type') {
    const opt = v['optional'] === true ? '?' : '';
    const inh = v['inherited'] === true ? ' (inherited)' : '';
    return `${String(v['name'])}${opt}: ${String(v['type'])}${inh}`;
  }
  // TypeRef (schema; also nested in an EndpointCard's query/body/response): { text, span(condensed),
  // confidence }. `text` is a type string (spaces) → never inlines. `span · type`.
  if (keys === 'confidence,span,text') {
    const conf = v['confidence'] === 'certain' ? '' : ` · ${String(v['confidence'])}`;
    return `${String(v['span'])} · ${flat(v['text'])}${conf}`;
  }
  // find_usages symbols-mode unresolved row: { name, reason }.
  if (keys === 'name,reason') {
    return `${String(v['name'])} · ${flat(v['reason'])}`;
  }
  // ListEntry (the `list` registry op): { key, confidence, file, line, col, proof, kind?,
  // provenance?, name?, segments?, detail? }. The registry row has no `id` to fold name+loc into, so
  // it exploded into one key=value line per field — collapse to a single clickable line. `proof` just
  // repeats file:line:col and `name` repeats `key`; both are dropped. kind/provenance decorate the
  // tail BUT are omitted when constant across the answer (hoisted to the header by `list`'s
  // `hoistUniform`) — so a uniform 652-row `components` listing prints `key · loc` rows, the
  // `· component · heuristic:react` stated once above. DISCRIMINANT: `proof` (every list entry
  // carries one — serializeEntry) + `key` + raw file/line/col; kind/provenance are NOT in the guard
  // (hoisted away), so `proof` is what keeps a future `{key,confidence,file,line,col}` row from
  // mis-collapsing here (id-bearing rows carry `id`; i18n/scss rows carry a `span`, not raw file).
  if (
    'key' in v &&
    'proof' in v &&
    'confidence' in v &&
    'file' in v &&
    'line' in v &&
    'col' in v &&
    !('id' in v)
  ) {
    const loc = `${String(v['file'])}:${String(v['line'])}:${String(v['col'])}`;
    const kind = v['kind'] !== undefined ? ` · ${String(v['kind'])}` : '';
    const conf = v['confidence'] === 'certain' ? '' : ` · ${String(v['confidence'])}`;
    const prov = v['provenance'] !== undefined ? ` · ${String(v['provenance'])}` : '';
    const detail = v['detail'] !== undefined ? ` · ${flat(v['detail'])}` : '';
    return `${String(v['key'])}${kind} · ${loc}${conf}${prov}${detail}`;
  }
  // EndpointCard (list_endpoints) — variadic (optional query/body/response/status/note), matched by
  // presence. query/body/response are TypeRefs already collapsed to `loc · type`; show just the type.
  if ('method' in v && 'path' in v && 'pathParams' in v) {
    const typeText = (s: string): string => {
      const i = s.indexOf(' · ');
      return i >= 0 ? s.slice(i + 3) : s;
    };
    const ref = (key: string, label: string): string =>
      v[key] !== undefined ? ` · ${label}=${typeText(String(v[key]))}` : '';
    const status = v['status'] !== undefined ? ` →${String(v['status'])}` : '';
    const conf = v['confidence'] === 'certain' ? '' : ` · ${String(v['confidence'])}`;
    const note = v['note'] !== undefined ? ` · ${flat(v['note'])}` : '';
    return `${String(v['method'])} ${String(v['path'])}${status}${ref('query', 'q')}${ref('body', 'body')}${ref('response', 'resp')}${conf}${note}`;
  }
  // LeftBehindEntry (extract_symbol cssCoExtract.leftBehind) — variadic { class, code, reason,
  // detail?, span?(condensed) }, matched by presence. reason/detail carry spaces.
  if ('class' in v && 'code' in v && 'reason' in v) {
    const loc = v['span'] !== undefined ? `${String(v['span'])} · ` : '';
    const detail = v['detail'] !== undefined ? ` — ${flat(v['detail'])}` : '';
    return `${loc}${String(v['class'])} · ${String(v['code'])} · ${flat(v['reason'])}${detail}`;
  }
  // css_cascade CascadeRuleView (a contributing rule) — `[spec] span · selector [flags] · {decls}`.
  if ('selector' in v && 'specificity' in v && 'declarations' in v) {
    const flags: string[] = [];
    if (v['crossModule'] === true) flags.push('cross-module');
    if (v['global'] === true) flags.push(':global');
    if (v['interpolated'] === true) flags.push('interpolated');
    for (const c of asArray(v['conditions'])) flags.push(String(c));
    for (const a of asArray(v['atContext'])) flags.push(String(a));
    const extra = asArray(v['requiresExtraClasses']);
    const extraStr = extra.length > 0 ? ` +.${extra.join('.')}` : '';
    const flagStr = flags.length > 0 ? ` · ${flags.join(',')}` : '';
    return `[${String(v['specificity'])}] ${String(v['span'])} · ${String(v['selector'])}${extraStr}${flagStr} · {${declList(v['declarations'])}}`;
  }
  // css_cascade CascadeProperty (the per-property verdict) — `prop: <winner>` + indented losers.
  if ('prop' in v && 'winner' in v) {
    const losers = asArray(v['losers']);
    const tail = losers.length > 0 ? `\n    loses: ${losers.map(String).join(' | ')}` : '';
    return `${String(v['prop'])}: ${String(v['winner'])}${tail}`;
  }
  // css_cascade CascadeWinner (winning declaration) — has `confidence`; checked before the
  // bare ref below so the verdict line carries the confidence + reason.
  if ('value' in v && 'confidence' in v && 'selector' in v) {
    const conf = v['confidence'] === 'certain' ? '' : ` · ${String(v['confidence'])}`;
    const note = v['note'] !== undefined ? ` · ${flat(v['note'])}` : '';
    const amb = asArray(v['ambiguousWith']);
    const ambStr = amb.length > 0 ? ` · ambiguous-with: ${amb.map(String).join(' | ')}` : '';
    return `${declRefLine(v)}${conf}${note}${ambStr}`;
  }
  // css_cascade CascadeDeclRef (a loser / co-winner) — `[spec] span · selector = value`.
  if ('value' in v && 'specificity' in v && 'selector' in v) {
    return declRefLine(v);
  }
  return v;
}

function asArray(value: JsonValue | undefined): readonly JsonValue[] {
  return value !== undefined && isJsonArray(value) ? value : [];
}

/** Optional per-usage provenance decorations (Task G program · merge decls) appended to a usage
 *  line. `program`/`programs` carry the surfacing tsconfig; `decls` (number[] flat | string group)
 *  the merged-declaration indices. Empty when none present — the common single-program non-merge row. */
function usageDeco(v: Record<string, JsonValue>): string {
  let s = '';
  const program = v['program'];
  if (typeof program === 'string') s += ` · prog ${program}`;
  const programs = v['programs'];
  if (typeof programs === 'string') s += ` · prog ${programs}`;
  const decls = v['decls'];
  if (decls !== undefined && isJsonArray(decls)) s += ` · decls[${decls.map(String).join(',')}]`;
  else if (typeof decls === 'string' && decls.length > 0) s += ` · decls[${decls}]`;
  return s;
}

/** `[spec] span · selector = value [!important]` — the shared line for a cascade decl ref. */
function declRefLine(v: Record<string, JsonValue>): string {
  const imp = v['important'] === true ? ' !important' : '';
  return `[${String(v['specificity'])}] ${String(v['span'])} · ${String(v['selector'])} = ${flat(v['value'])}${imp}`;
}

/** `prop:value [!important]; …` for a rule's declaration list (objects already condensed). */
function declList(value: JsonValue | undefined): string {
  return asArray(value)
    .map((d) => {
      if (typeof d === 'object' && d !== null && !Array.isArray(d)) {
        const o = d as Record<string, JsonValue>;
        const imp = o['important'] === true ? ' !important' : '';
        return `${String(o['prop'])}:${flat(o['value'])}${imp}`;
      }
      return String(d);
    })
    .join('; ');
}

/** Flatten a free-text field (TS message, type string, locale value, reason) to one line — a
 *  newline would otherwise split a collapsed one-liner into orphan, unanchored lines. */
function flat(value: JsonValue | undefined): string {
  return String(value).replace(/\s+/g, ' ');
}

/** Summarize a (condensed) react-query QueryKeyView to its literal form — `['a', <id>]` for an
 *  array key, `<opaque>` for a non-array key, `(all)` when absent. Structural over JsonValue (the
 *  format layer must not import plugins/react-query); MIRRORS `ops/react-query-invalidations-for`'s
 *  `renderKey` (the sql-table renderer). The render-contract guard cross-pins the two so they can
 *  never silently diverge (text vs sql showing a different key) — hence the export. */
export function summarizeQueryKey(key: JsonValue | undefined): string {
  if (!isObject(key)) return '(all)';
  if (key['opaque'] !== undefined) return `<${String(key['opaque'])}>`;
  const segs = asArray(key['segments']).map((s) =>
    isObject(s) && s['kind'] === 'static'
      ? JSON.stringify(s['value'])
      : isObject(s)
        ? `<${String(s['shape'])}>`
        : String(s),
  );
  return `[${segs.join(', ')}]`;
}

function renderSpanLine(span: Record<string, JsonValue>, verbosity: Verbosity): string {
  const loc = `${String(span['file'])}:${String(span['line'])}:${String(span['col'])}`;
  if (verbosity === 'terse') return loc;
  const firstLine = String(span['text']).split('\n')[0] ?? '';
  const text =
    firstLine.length > NORMAL_TEXT_CAP ? `${firstLine.slice(0, NORMAL_TEXT_CAP)}…` : firstLine;
  return text.length > 0 ? `${loc} · ${text}` : loc;
}

function looksLikeSpan(v: Record<string, JsonValue>): boolean {
  return (
    typeof v['file'] === 'string' &&
    typeof v['line'] === 'number' &&
    typeof v['col'] === 'number' &&
    typeof v['endLine'] === 'number' &&
    typeof v['text'] === 'string'
  );
}

function isJsonArray(value: JsonValue): value is readonly JsonValue[] {
  return Array.isArray(value);
}

function isObject(value: JsonValue | undefined): value is Record<string, JsonValue> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
