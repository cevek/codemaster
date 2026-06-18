// CSS-modules scoping-pseudo handling shared across the scss plugin's module-local analyses
// (parse.ts ownership, the co-extract taxonomy, the cascade). One helper, two consumers — not
// duplicated regexes.
//
// `:local(.foo)` is the EXPLICIT spelling of the default module scoping: postcss-modules
// compiles it to `.foo`, so for any module-local question the wrapped selector simply IS the
// inner selector. `:global(.x)` is the opposite (explicit global) and is deliberately left
// intact — callers keep their own global handling, so unwrapping it would erase the distinction
// (the symmetry the trust contract needs). The bare-prefix `:local .x` and block `:local { … }`
// forms are NOT touched here — only the paren subject form.

/** Replace every `:local(<inner>)` with `<inner>` (recursively, so a nested `:local` unwraps
 *  too), leaving the rest of the selector — `:global(…)` included — untouched. A no-op when no
 *  `:local(` appears, so a plain selector is returned unchanged. Paren-depth-aware: the inner of
 *  `:local(.a:not(.b))` is the whole `.a:not(.b)`, never truncated at the first `)`. */
export function unwrapLocalScope(selector: string): string {
  if (!/:local\s*\(/.test(selector)) return selector;
  let out = '';
  let i = 0;
  while (i < selector.length) {
    const m = /^:local\s*\(/.exec(selector.slice(i));
    if (m !== null) {
      const open = i + m[0].length - 1; // index of the '('
      const close = matchParen(selector, open);
      out += unwrapLocalScope(selector.slice(open + 1, close));
      i = close + 1;
      continue;
    }
    out += selector[i];
    i++;
  }
  return out;
}

/** Index of the `)` matching the `(` at `open`, honouring nested parens; the string end if
 *  unbalanced (tolerant — a malformed selector is never a throw, §3.6). */
function matchParen(s: string, open: number): number {
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    if (s[i] === '(') depth++;
    else if (s[i] === ')' && --depth === 0) return i;
  }
  return s.length;
}
