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

/** A CSS-module stylesheet the scss plugin indexes — exactly the extensions the TS plugin's
 *  css-module usage scanner observes (`/\.(scss|sass|css)$/`). Index and scanner MUST stay in
 *  lockstep: a sheet the scanner sees imports of but the index skips would diverge into a
 *  false-unused (§3). */
export function isStylesheetFile(file: string): boolean {
  return /\.(scss|sass|css)$/.test(file);
}

/** True for a CSS-MODULE sheet — the `.module.*` filename convention bundlers use to enable
 *  scoped class names, where a class is referenced as `s.foo` and IS resolvable. A flat
 *  `.scss`/`.css`/`.sass` is a GLOBAL stylesheet: its classes are referenced via string
 *  `className="foo"`, which codemaster does not resolve, so a flat-sheet class is never
 *  provably dead — find_unused demotes it to `partial` rather than a false `certain` (§3.3). */
export function isCssModuleFile(file: string): boolean {
  return /\.module\.(scss|sass|css)$/.test(file);
}

/** `from` is the value postcss embeds in error messages — pass an absolute `<root>/<file>`
 *  so a failure carries an accurate, scrubbable path (a relative `from` resolves against cwd,
 *  pointing at a file that isn't there — §scrub-root). Defaults to `file` for tests. */
export function parseStylesheetRoot(source: string, file: string, from = file): ParsedRoot {
  const syntax = isSassFile(file) ? postcssScss : postcss;
  try {
    return { ok: true, root: syntax.parse(source, { from }) };
  } catch (thrown) {
    return { ok: false, message: thrown instanceof Error ? thrown.message : String(thrown) };
  }
}
