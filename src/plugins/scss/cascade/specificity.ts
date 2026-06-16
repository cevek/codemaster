// Selector specificity (W3C Selectors-4) + subject analysis — the floor of the resolved
// cascade view (spec-css-cascade-op). Pure string analysis over a single ALREADY-RESOLVED
// complex selector branch (nesting/`&` expanded by `rules.ts` first); no postcss, no I/O.
//
// Specificity is the (a,b,c) triple: a = #id selectors · b = #class/#attribute/#pseudo-class
// · c = #type/#pseudo-element. The selector-list pseudos take the MAX specificity of their
// argument list (`:is`/`:not`/`:has`), `:where(…)` contributes 0 — matching the spec, so a
// cross-module override is ordered correctly and never under/over-counted.

/** The (a,b,c) specificity triple. Higher `a`, then `b`, then `c` wins. */
export type Specificity = { a: number; b: number; c: number };

/** Why a branch is not an UNCONDITIONAL, context-free match of a bare `.target` element —
 *  each reason is honest uncertainty the resolver turns into `partial` (§3.3): the rule may
 *  not actually apply to a given element, so it is never a proven winner. Target-independent
 *  (the "requires another class" reason is computed by the resolver, which knows the target). */
export type ConditionReason =
  | 'descendant' // a combinator (ancestor / child / sibling) — needs surrounding context
  | 'pseudo-class' // `:hover` / `:nth-child` / … — applies only in that state/position
  | 'attribute' // `[data-x]` — applies only when the attribute is present
  | 'negation' // `:not(…)` — narrows which elements match
  | 'pseudo-element' // `::before` — styles a generated box, not the element itself
  | 'element-type' // `button.foo` — applies only to that element type
  | 'id'; // `#nav.foo` — applies only to the element bearing that id

export type SelectorTraits = {
  /** Class tokens of the SUBJECT (rightmost compound) — what an element must carry to match. */
  subjectClasses: string[];
  /** Conditions that make the branch less than an unconditional context-free match. */
  conditions: ConditionReason[];
  /** The selector used interpolation (`#{…}`) — specificity is a lower bound, flagged. */
  interpolated: boolean;
};

export function compareSpecificity(x: Specificity, y: Specificity): number {
  if (x.a !== y.a) return x.a < y.a ? -1 : 1;
  if (x.b !== y.b) return x.b < y.b ? -1 : 1;
  if (x.c !== y.c) return x.c < y.c ? -1 : 1;
  return 0;
}

export function specificityEqual(x: Specificity, y: Specificity): boolean {
  return x.a === y.a && x.b === y.b && x.c === y.c;
}

export function formatSpecificity(s: Specificity): string {
  return `${s.a},${s.b},${s.c}`;
}

const ZERO: Specificity = { a: 0, b: 0, c: 0 };

function add(x: Specificity, y: Specificity): Specificity {
  return { a: x.a + y.a, b: x.b + y.b, c: x.c + y.c };
}

/** Remove SCSS interpolation (`#{…}`) spans so the tokenizer never sees the bare `#`/`{`/`$`
 *  inside one and miscounts it as an id/type (which would corrupt the (a,b,c) ordering of
 *  EVERY rule, not just the interpolated one). Callers flag `interpolated` separately and
 *  treat the result as a lower bound; here we just neutralise the span to specificity-0. */
function stripInterpolation(selector: string): string {
  if (!selector.includes('#{')) return selector;
  let out = '';
  let i = 0;
  while (i < selector.length) {
    if (selector[i] === '#' && selector[i + 1] === '{') {
      let depth = 0;
      let j = i + 1;
      for (; j < selector.length; j++) {
        if (selector[j] === '{') depth++;
        else if (selector[j] === '}' && --depth === 0) {
          j++;
          break;
        }
      }
      i = j;
      continue;
    }
    out += selector[i];
    i++;
  }
  return out;
}

/** Index of the `]` closing the `[` at `open`, skipping quoted attribute values (so a `]`
 *  inside `[title="a]b"]` does not end the bracket early); the string end if unbalanced. */
function closeBracket(s: string, open: number): number {
  let quote = '';
  for (let i = open + 1; i < s.length; i++) {
    const c = s[i];
    if (quote !== '') {
      if (c === '\\') i++;
      else if (c === quote) quote = '';
      continue;
    }
    if (c === '"' || c === "'") quote = c;
    else if (c === ']') return i;
  }
  return s.length - 1;
}

/** Split a complex selector into compound segments, dropping the combinators but recording
 *  whether ANY appeared. `[…]` is consumed atomically (quote-aware) and `(…)` via depth, so a
 *  combinator/space inside `:not(.a .b)` or `[attr~="x y"]` never splits the outer selector. */
function splitCompounds(selector: string): { compounds: string[]; hasCombinator: boolean } {
  const compounds: string[] = [];
  let buf = '';
  let depth = 0;
  let hasCombinator = false;
  const flush = (): void => {
    if (buf.length > 0) compounds.push(buf);
    buf = '';
  };
  for (let i = 0; i < selector.length; i++) {
    const ch = selector[i] ?? '';
    if (ch === '[') {
      const end = closeBracket(selector, i);
      buf += selector.slice(i, end + 1);
      i = end;
      continue;
    }
    if (ch === '(') depth++;
    else if (ch === ')') depth = Math.max(0, depth - 1);
    if (depth === 0) {
      if (ch === '>' || ch === '+' || ch === '~') {
        flush();
        hasCombinator = true;
        continue;
      }
      if (/\s/.test(ch)) {
        if (buf.length > 0) {
          flush();
          hasCombinator = true; // descendant combinator (whitespace) — collapsed runs count once
        }
        continue;
      }
    }
    buf += ch;
  }
  flush();
  return { compounds, hasCombinator };
}

/** One simple-selector token within a compound: the leading punctuation classifies it,
 *  parenthesised pseudo arguments are kept whole. */
type SimpleToken = {
  kind: 'id' | 'class' | 'attr' | 'pseudo' | 'pseudo-el' | 'type';
  text: string;
};

/** Tokenise a single compound selector into simple selectors. `*` and `&` (an unresolved
 *  parent ref — rules.ts resolves the common cases) contribute nothing and are dropped. */
function tokenizeCompound(compound: string): SimpleToken[] {
  const tokens: SimpleToken[] = [];
  let i = 0;
  const n = compound.length;
  while (i < n) {
    const ch = compound[i] ?? '';
    if (ch === '*' || ch === '&') {
      i++;
      continue;
    }
    if (ch === '[') {
      const stop = closeBracket(compound, i) + 1;
      tokens.push({ kind: 'attr', text: compound.slice(i, stop) });
      i = stop;
      continue;
    }
    if (ch === '#' || ch === '.') {
      const m = /^[#.]-?[_a-zA-Z][\w-]*/.exec(compound.slice(i));
      const text = m?.[0] ?? compound.slice(i, i + 1);
      tokens.push({ kind: ch === '#' ? 'id' : 'class', text });
      i += text.length;
      continue;
    }
    if (ch === ':') {
      const isElement = compound[i + 1] === ':';
      const nameStart = i + (isElement ? 2 : 1);
      const nameMatch = /^-?[_a-zA-Z][\w-]*/.exec(compound.slice(nameStart));
      const name = nameMatch?.[0] ?? '';
      let stop = nameStart + name.length;
      let args = '';
      if (compound[stop] === '(') {
        const close = matchParen(compound, stop);
        args = compound.slice(stop + 1, close);
        stop = close + 1;
      }
      tokens.push({
        kind: isElement ? 'pseudo-el' : 'pseudo',
        text: `:${isElement ? ':' : ''}${name}${args !== '' ? `(${args})` : ''}`,
      });
      i = stop;
      continue;
    }
    // A type/element name (or stray char): consume an identifier run, else one char.
    const m = /^-?[_a-zA-Z][\w-]*/.exec(compound.slice(i));
    if (m?.[0] !== undefined && m[0].length > 0) {
      tokens.push({ kind: 'type', text: m[0] });
      i += m[0].length;
    } else i++;
  }
  return tokens;
}

/** Index of the `)` matching the `(` at `open`, honouring nested parens; the string end if
 *  unbalanced (a tolerant parse — a malformed selector is never a throw, §3.6). */
function matchParen(s: string, open: number): number {
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    if (s[i] === '(') depth++;
    else if (s[i] === ')') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return s.length;
}

const SELECTOR_LIST_PSEUDOS = new Set(['is', 'not', 'has', 'matches']);

/** The name of a pseudo token (`:hover` → `hover`, `::before` → `before`). */
function pseudoName(text: string): string {
  return text.replace(/^::?/, '').replace(/\(.*$/s, '');
}

function pseudoArgs(text: string): string {
  const open = text.indexOf('(');
  return open === -1 ? '' : text.slice(open + 1, text.lastIndexOf(')'));
}

/** CSS-modules scoping pseudos — compiled AWAY (`:global(.a#b)` emits `.a#b`), so they are
 *  specificity-TRANSPARENT: the wrapper itself counts 0, the ARGUMENT's specificity cascades.
 *  Counting `:global(#id)` as a single class (the default-pseudo path) would collapse an
 *  id-level rule to class-level and silently mis-order the cascade. */
const SCOPING_PSEUDOS = new Set(['global', 'local']);

/** Specificity contributed by ONE pseudo-class token. The selector-list pseudos
 *  (`:is`/`:not`/`:has`) take the MAX of their argument selectors; `:where` is always 0;
 *  `:global`/`:local` are transparent (the argument's specificity, 0 for the bare keyword). */
function pseudoSpecificity(token: SimpleToken): Specificity {
  const name = pseudoName(token.text).toLowerCase();
  if (name === 'where') return ZERO;
  if (SCOPING_PSEUDOS.has(name)) {
    const args = pseudoArgs(token.text);
    return args === '' ? ZERO : specificityOfComplex(args);
  }
  if (SELECTOR_LIST_PSEUDOS.has(name)) {
    const args = pseudoArgs(token.text);
    let max = ZERO;
    for (const branch of splitTopLevel(args, ',')) {
      const s = specificityOfComplex(branch.trim());
      if (compareSpecificity(s, max) > 0) max = s;
    }
    return max;
  }
  return { a: 0, b: 1, c: 0 }; // an ordinary pseudo-class counts as one class
}

/** Split a selector list on top-level commas (paren/bracket-aware) — shared with rules.ts so
 *  nesting resolution splits comma branches exactly as specificity counts them. */
export function splitSelectorList(s: string): string[] {
  return splitTopLevel(s, ',')
    .map((b) => b.trim())
    .filter((b) => b.length > 0);
}

/** Split on a delimiter at paren/bracket depth 0 only — for selector-list pseudo arguments. */
function splitTopLevel(s: string, delim: string): string[] {
  const out: string[] = [];
  let buf = '';
  let depth = 0;
  for (const ch of s) {
    if (ch === '(' || ch === '[') depth++;
    else if (ch === ')' || ch === ']') depth = Math.max(0, depth - 1);
    if (ch === delim && depth === 0) {
      out.push(buf);
      buf = '';
    } else buf += ch;
  }
  out.push(buf);
  return out;
}

/** Specificity of a whole complex selector branch (all compounds summed). */
export function specificityOfComplex(selector: string): Specificity {
  const { compounds } = splitCompounds(stripInterpolation(selector));
  let total = ZERO;
  for (const compound of compounds) {
    for (const token of tokenizeCompound(compound)) {
      switch (token.kind) {
        case 'id':
          total = add(total, { a: 1, b: 0, c: 0 });
          break;
        case 'class':
        case 'attr':
          total = add(total, { a: 0, b: 1, c: 0 });
          break;
        case 'pseudo':
          total = add(total, pseudoSpecificity(token));
          break;
        case 'pseudo-el':
        case 'type':
          total = add(total, { a: 0, b: 0, c: 1 });
          break;
      }
    }
  }
  return total;
}

/** Analyse a resolved selector branch: specificity, subject classes, and the conditions that
 *  keep it from being an unconditional context-free match. `interpolated` flags `#{…}`. */
export function analyzeBranch(selector: string): {
  specificity: Specificity;
  traits: SelectorTraits;
} {
  const interpolated = selector.includes('#{');
  const { compounds, hasCombinator } = splitCompounds(stripInterpolation(selector));
  const subject = compounds[compounds.length - 1] ?? '';
  const subjectTokens = tokenizeCompound(subject);
  const subjectClasses: string[] = [];
  const conditions = new Set<ConditionReason>();
  if (hasCombinator) conditions.add('descendant');
  for (const token of subjectTokens) {
    switch (token.kind) {
      case 'class':
        subjectClasses.push(token.text.slice(1));
        break;
      case 'attr':
        conditions.add('attribute');
        break;
      case 'pseudo-el':
        conditions.add('pseudo-element');
        break;
      case 'pseudo': {
        const pname = pseudoName(token.text).toLowerCase();
        // `:global`/`:local` are scoping markers, not state — the `global` flag carries their
        // uncertainty (rules.ts); don't double-report them as a state pseudo-class.
        if (SCOPING_PSEUDOS.has(pname)) break;
        conditions.add(pname === 'not' ? 'negation' : 'pseudo-class');
        break;
      }
      case 'type':
        // `button.foo` matches only `<button>`, so a same-name element elsewhere is unaffected
        // — a real restriction, never an unconditional (certain) match.
        conditions.add('element-type');
        break;
      case 'id':
        conditions.add('id');
        break;
    }
  }
  return {
    specificity: specificityOfComplex(selector),
    traits: { subjectClasses, conditions: [...conditions], interpolated },
  };
}
