// Parse one stylesheet into a postcss CST `Root` — the substrate the co-extract taxonomy
// (extract-classify) and rule transform (extract-rules) both walk. `.scss`/`.sass` parse
// through postcss-scss (preserves Sass syntax on serialization); `.css` through plain
// postcss. A parse error is returned, never thrown (§3.6) — the caller leaves every
// candidate class behind with an honest note rather than guessing a move.

import postcss, { type Root } from 'postcss';
import postcssScss from 'postcss-scss';

export type ParsedRoot = { ok: true; root: Root } | { ok: false; message: string };

/** True for a sheet whose syntax needs the Sass parser (`.scss` / `.sass`). */
export function isSassFile(file: string): boolean {
  return /\.s[ac]ss$/.test(file);
}

export function parseStylesheetRoot(source: string, file: string): ParsedRoot {
  const syntax = isSassFile(file) ? postcssScss : postcss;
  try {
    return { ok: true, root: syntax.parse(source, { from: file }) };
  } catch (thrown) {
    return { ok: false, message: thrown instanceof Error ? thrown.message : String(thrown) };
  }
}
