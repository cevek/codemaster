// Span loc/text extraction over the ALREADY-CONDENSED span. condense.ts runs bottom-up, so by
// the time a shape renderer runs its `span` child is a STRING at terse/normal (`loc` / `loc · text`)
// or a verbatim OBJECT at full (for a `collapse`-disposition form, FULL_DISPOSITION). These let a renderer drop the
// normal-mode text echo (keep just the clickable loc) or dedup a sibling field against the span's
// proof text — without re-deriving the span. Terse has no text, so `spanTextOf` returns '' there
// and a text-vs-field comparison safely no-ops (the field is the only identifier — never stripped).

import type { JsonValue } from '../../../core/json.ts';
import { isObject } from './helpers.ts';

const SEP = ' · ';
const QUOTES = new Set(['"', "'", '`']);

/** The clickable `file:line:col`, stripping any normal-mode `· text` suffix. Object (full) → its
 *  loc; string → the part before the separator (the whole string when there is no text). */
export function spanLocOnly(span: JsonValue | undefined): string {
  if (isObject(span))
    return `${String(span['file'])}:${String(span['line'])}:${String(span['col'])}`;
  const s = String(span);
  return s.split(SEP)[0] ?? s;
}

/** The span's proof TEXT (first line) when condense attached one, else '' (terse carries no text).
 *  Object (full) → first line of `text`; string → the part after the separator. */
export function spanTextOf(span: JsonValue | undefined): string {
  if (isObject(span)) return String(span['text']).split('\n')[0] ?? '';
  return String(span).split(SEP)[1] ?? '';
}

/** Strip one matching pair of surrounding quotes (`'` / `"` / `` ` ``) — so a span's verbatim
 *  source token (`'a.b.c'`, `"save"`) compares quote-agnostically against a dotted key/segment. */
export function unquote(s: string): string {
  const first = s.charAt(0);
  return s.length >= 2 && QUOTES.has(first) && s.charAt(s.length - 1) === first
    ? s.slice(1, -1)
    : s;
}
