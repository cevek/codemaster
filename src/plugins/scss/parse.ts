// Parse one SCSS file into class declarations via postcss-scss — a CST, syntactic
// only (§19): nesting is resolved for plain `&`-composition, but cross-`@use` /
// `@forward` visibility and computed selectors are beyond this parse and must be
// reported `partial` by consumers, never guessed.
//
// Two resolutions go beyond a bare `.token` scan (spec-scss-css-honesty Stage 2):
//   - parent-ref BEM concat: `.block { &__el {} &--mod {} }` compiles to the FLAT classes
//     `block__el` / `block--mod`, so a TS access `s['block__el']` can match — we synthesize
//     those names with a span over the real `&__el` source token (never `.block__el`, which
//     isn't in the file).
//   - `:global(...)` break-out: a selector inside `:global` is NOT a module-local class, so
//     its classes are excluded from the module-local set.

import postcss, { type Rule } from 'postcss';
import postcssScss from 'postcss-scss';
import type { RepoRelPath } from '../../core/brands.ts';
import type { Span } from '../../core/span.ts';
import { isSassFile } from './parse-root.ts';
import {
  selectorIsOwnedBy,
  composesLocalTargets,
  composesImportedTargets,
  parseExtendTargets,
} from './extract-classify.ts';

export type ScssClass = {
  /** Class name without the leading dot. */
  name: string;
  span: Span;
  /** True when the name came from a selector we could only partially resolve
   *  (interpolation, parent-composition we don't expand). */
  partial: boolean;
};

/** Per-sheet reachability facts `find_unused_scss_classes` consults so it never reports a
 *  not-provably-dead class as `certain` unused (spec-scss-css-honesty Stage 1). Reuses the
 *  co-extract taxonomy's selector/ownership/composes predicates — not a second parser. */
export type SheetReachability = {
  /** Classes that appear in the sheet but have NO cleanly-owned top-level rule (`.X {}` at
   *  root with no nested children) — they live only in compound / descendant / nested /
   *  at-rule / parent-context selectors, so deleting them is not provably safe → `partial`. */
  entangledOnly: ReadonlySet<string>;
  /** Classes reachable via CSS-modules `composes:` linkage from another rule, or via `@extend`
   *  — a TS-unreferenced one is still reached through the composer/extender → not provably dead. */
  linkedReachable: ReadonlySet<string>;
  /** This sheet's CROSS-sheet `composes: x from './other'` links — `{ name, from }` per imported
   *  class. `find_unused` resolves `from` (relative-only) to the provider sheet and marks the
   *  named class reachable there, so a class reached only across sheets is never `certain` dead. */
  importedComposes: readonly { name: string; from: string }[];
};

export type ScssParseOutcome =
  | { ok: true; classes: ScssClass[]; reachability: SheetReachability }
  | { ok: false; message: string };

const CLASS_TOKEN = /\.(-?[_a-zA-Z][\w-]*)/g;
// A parent-ref concat: `&` glued directly to BEM-ish identifier chars (`&__el`, `&--mod`,
// `&suffix`). `&.x` / `&:hover` do NOT match (the next char is `.`/`:`, not `[\w-]`) — those
// carry their own `.class` token (or none) and are handled by CLASS_TOKEN.
const AMP_CONCAT = /&([\w-]+)/g;

// `from` is the path postcss embeds in error messages — pass an absolute `<root>/<rel>` so a
// parse failure carries an accurate, scrubbable path (a relative `from` resolves against cwd —
// §scrub-root). Defaults to `rel` for tests. `.css` parses through plain postcss (it has no Sass
// syntax); `.scss`/`.sass` through postcss-scss — matching the index gate's extension set.
export function parseScssClasses(
  rel: RepoRelPath,
  source: string,
  from: string = rel,
): ScssParseOutcome {
  let root;
  try {
    const syntax = isSassFile(rel) ? postcssScss : postcss;
    root = syntax.parse(source, { from });
  } catch (thrown) {
    return { ok: false, message: thrown instanceof Error ? thrown.message : String(thrown) };
  }

  const classes: ScssClass[] = [];
  const referenced = new Set<string>(); // class appears in some selector (any shape)
  const owned = new Set<string>(); // class has ≥1 cleanly-owned top-level rule
  root.walkRules((rule) => {
    const start = rule.source?.start;
    if (start === undefined) return;
    const selector = rule.selector;
    const hasInterpolation = selector.includes('#{');
    // A rule nested under a bare `:global { … }` block breaks out of module scope entirely —
    // none of its classes are module-local. Skip the whole rule (both `.class` tokens and
    // synthesized `&` concats), the block-form complement to the within-selector exclusion.
    if (underGlobalBlock(rule)) return;
    const globals = globalRanges(selector);
    // A class is cleanly attributable to THIS rule only when the rule is a top-level (root)
    // single-class rule with no nested children — the same notion the co-extract taxonomy
    // proves before moving. Anything else (descendant / compound / nested / at-rule context)
    // leaves its classes entangled.
    const cleanTop = rule.parent?.type === 'root' && !hasNestedRule(rule);

    const push = (name: string, index: number, text: string): void => {
      const before = selector.slice(0, index);
      const lineOffset = countLines(before);
      const col = lineOffset === 0 ? start.column + index : colInLastLine(before);
      classes.push({
        name,
        span: {
          file: rel,
          line: start.line + lineOffset,
          col,
          endLine: start.line + lineOffset,
          endCol: col + text.length,
          text,
        },
        partial: hasInterpolation,
      });
      referenced.add(name);
      if (cleanTop && selectorIsOwnedBy(selector, name)) owned.add(name);
    };

    // Module-local `.class` tokens — skipping any inside a `:global(...)` break-out.
    for (const match of selector.matchAll(CLASS_TOKEN)) {
      const name = match[1];
      if (name === undefined || match.index === undefined) continue;
      if (inRanges(match.index, globals)) continue; // `:global` class — not module-local
      push(name, match.index, `.${name}`);
    }

    // Parent-ref concat → synthesized flat class name (`&__el` under `.block` → `block__el`).
    // These never own a top-level rule (their rule is nested), so they stay entangled.
    if (selector.includes('&')) {
      // `&` substitutes the parent selector; a glued suffix attaches to the LAST class of each
      // parent comma-branch's trailing compound (`.a.b { &__el }` → `b__el`, not `a__el`;
      // `.a, .b { &__el }` → both `a__el` and `b__el`). One synthesized name per (base × suffix).
      const bases = ampBases(rule);
      for (const match of selector.matchAll(AMP_CONCAT)) {
        const suffix = match[1];
        if (suffix === undefined || match.index === undefined) continue;
        if (inRanges(match.index, globals)) continue;
        for (const base of bases) push(base + suffix, match.index, match[0]);
      }
    }
  });

  const entangledOnly = new Set<string>();
  for (const name of referenced) if (!owned.has(name)) entangledOnly.add(name);

  const linkedReachable = new Set<string>();
  const importedComposes: { name: string; from: string }[] = [];
  root.walkDecls('composes', (decl) => {
    for (const name of composesLocalTargets(decl.value)) linkedReachable.add(name);
    importedComposes.push(...composesImportedTargets(decl.value));
  });
  root.walkAtRules('extend', (at) => {
    for (const name of parseExtendTargets(at.params)) linkedReachable.add(name);
  });

  return { ok: true, classes, reachability: { entangledOnly, linkedReachable, importedComposes } };
}

/** True when any ANCESTOR rule's selector is a bare `:global` (the `:global { … }` block form,
 *  which scopes everything inside it out of module-local space). The within-selector forms
 *  (`:global(.x)`, `:global .x`) are handled per-selector by `globalRanges`; this catches the
 *  block form, where the broken-out classes live in separate child rules. */
function underGlobalBlock(rule: Rule): boolean {
  let node = rule.parent;
  while (node !== undefined && node.type === 'rule') {
    if (/^:global$/.test((node as Rule).selector.trim())) return true;
    node = node.parent;
  }
  return false;
}

/** True when a rule has any descendant rule (a nested selector buried even inside a `@media`
 *  block) — such a rule can't be a cleanly-attributable single-class declaration. */
function hasNestedRule(rule: Rule): boolean {
  let nested = false;
  rule.walkRules(() => {
    nested = true;
  });
  return nested;
}

/** The base class name(s) a child's `&` concatenates onto — the LAST class of EACH parent
 *  comma-branch's trailing compound (the segment `&` glues to), itself `&`-resolved so deeper
 *  BEM chains follow (`.a.b { &__c { &--d } }` → `b__c--d`). Empty when there is no parent rule
 *  or no branch yields a clean class — we then synthesize nothing (§3: never guess a name). */
function ampBases(rule: Rule): string[] {
  const parent = rule.parent;
  if (parent === undefined || parent.type !== 'rule') return [];
  return primaryClasses(parent as Rule);
}

/** The class name(s) a rule's selector resolves to at the point an `&` child glues on — one per
 *  comma-branch. A `&suffix` head resolves through the grandparent recursively; a branch whose
 *  trailing compound has no clean class (pseudo / attribute / element tail) is dropped, not guessed. */
function primaryClasses(rule: Rule): string[] {
  const out: string[] = [];
  for (const branch of rule.selector.split(',')) {
    const head = branch.trim();
    if (head.length === 0) continue;
    const ampHead = /^&([\w-]+)/.exec(head);
    if (ampHead?.[1] !== undefined) {
      for (const base of ampBases(rule)) out.push(base + ampHead[1]);
      continue;
    }
    const base = trailingCompoundClass(head);
    if (base !== undefined) out.push(base);
  }
  return out;
}

/** The last simple `.class` of a selector branch's TRAILING compound — the segment a glued `&`
 *  suffix attaches to. `.a.b` → `b`; `.outer .blk` → `blk`; `.blk:hover` / `.blk[x]` → undefined
 *  (a pseudo / attribute tail isn't a clean class to glue onto, so we don't synthesize a name). */
function trailingCompoundClass(branch: string): string | undefined {
  const compounds = branch.split(/[\s>+~]+/).filter((s) => s.length > 0);
  const last = compounds[compounds.length - 1];
  if (last === undefined || /[:[]/.test(last)) return undefined;
  const classes = last.match(/\.(-?[_a-zA-Z][\w-]*)/g);
  const lastClass = classes?.[classes.length - 1];
  // It must be the literal tail of the compound (no element / `*` / other token after it).
  return lastClass !== undefined && last.endsWith(lastClass) ? lastClass.slice(1) : undefined;
}

/** Index ranges of the selector string that sit inside a `:global` break-out (the paren form
 *  `:global(.x)` or the bare prefix `:global .x` scoping the rest of its comma-branch). */
function globalRanges(selector: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  const re = /:global\s*(?:\(([^)]*)\)|\b)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(selector)) !== null) {
    if (selector[m.index + m[0].length - 1] === ')') {
      ranges.push([m.index, m.index + m[0].length]); // paren form: class is inside the parens
    } else {
      const comma = selector.indexOf(',', m.index); // bare `:global` → rest of this branch
      ranges.push([m.index, comma === -1 ? selector.length : comma]);
    }
  }
  return ranges;
}

function inRanges(index: number, ranges: ReadonlyArray<readonly [number, number]>): boolean {
  return ranges.some(([s, e]) => index >= s && index < e);
}

function countLines(text: string): number {
  let n = 0;
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) n++;
  return n;
}

function colInLastLine(text: string): number {
  const idx = text.lastIndexOf('\n');
  return text.length - idx; // 1-based column within that line
}
