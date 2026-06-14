// Emit a string literal that preserves the quote style already at a position — so an
// import-specifier rewrite keeps the file's single/double/backtick convention instead of
// normalising it (a normalisation would be noise in the diff and could fight prettier).
//
// Escaping is derived from `JSON.stringify`, which already escapes backslashes, the
// double quote, and control chars (newline, tab, …) correctly. For single-quote and
// template styles we re-delimit that canonical form: a backslash mis-escape would emit a
// literal whose value silently differs from `text` — a corrupted edit the trust contract
// forbids.

/** Quote `text` in the style of the literal that starts at `literalStart` in `source`.
 *  Reads the actual opening quote char; falls back to a double-quoted `JSON.stringify`
 *  when the position is not on a known quote char (defensive — a non-literal offset). */
export function emitQuoted(source: string, literalStart: number, text: string): string {
  const q = source[literalStart];
  if (q === "'") return singleQuoted(text);
  if (q === '`') return templateQuoted(text);
  return JSON.stringify(text); // double-quote style and the defensive fallback
}

/** Inner body of `JSON.stringify(text)` — fully escaped, double quotes as `\"`. */
function jsonInner(text: string): string {
  return JSON.stringify(text).slice(1, -1);
}

function singleQuoted(text: string): string {
  // `\"` is over-escaped for a single-quoted literal; a bare `'` must be escaped instead.
  const inner = jsonInner(text).replace(/\\"/g, '"').replace(/'/g, "\\'");
  return "'" + inner + "'";
}

function templateQuoted(text: string): string {
  // In a template: `\"` relaxes to `"`, but the backtick and an interpolation `${` opener
  // must be escaped or they break the literal / inject an expression.
  const inner = jsonInner(text).replace(/\\"/g, '"').replace(/`/g, '\\`').replace(/\$\{/g, '\\${');
  return '`' + inner + '`';
}
