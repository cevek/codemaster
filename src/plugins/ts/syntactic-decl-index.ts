// The declaration INDEX and the candidate-collapse POLICY behind `source { syntactic: true }`
// (t-229522). Split from the addressing dispatch (`syntactic-decl.ts`) because it answers a different
// question: not "where did the agent point" but "given N declarations that share a name, which of them
// are ONE symbol and which are rivals" — the question whose wrong answer is a silent pick.
//
// THE POLICY, and what it may CLAIM. TypeScript rejects a non-mergeable duplicate WITHIN one binding
// scope, so several same-named declarations in the SAME scope are one symbol seen several times (an
// overload set, `interface` + `namespace`) — that direction is sound, and it is the only direction this
// module asserts. The converse is NOT sound: different scopes do not prove different symbols (two
// `declare global { interface Win }` blocks, two `namespace Ns` bodies, and a function-scoped `var` in two
// blocks are each ONE symbol declared in several regions). So a same-scope set COLLAPSES, and anything
// else comes back as a pick-list that reports what was OBSERVED — a scope boundary — without a verdict
// on identity, which needs the checker this path does without.
//
// Getting the collapse direction wrong is the expensive error: this surface indexes nested, member and
// loop declarations, so same-name-different-region is routine (`class A { run(){} }` beside
// `class B { run(){} }`, a `const tmp` in each of two functions, two `for (let i…)` headers in one body),
// and picking one while calling the other "another definition of it" asserts a merge the set cannot
// support (§3.4/§6). Erring the other way costs a pick-list the agent can resolve in one more call.
//
// The premise holds for SCOPE BINDINGS, which is why `isScopeContainer` must list every construct that
// binds (a loop header and a catch clause bind their own variable; a function binds its parameters) —
// each omission merges two sibling regions into one symbol. And it does NOT hold for an EXPANDO property
// assignment (`Foo.bar = …`), which binds nothing: two of those share whatever scope encloses them, so
// the assignment TARGET joins the scope key instead.

import ts from 'typescript';
import type { RepoRelPath } from '../../core/brands.ts';
import { mintRepoRelPath } from '../../support/fs/canonicalize.ts';
import type { SymbolView } from './query-types.ts';
import { DECL_TEXT_CAP, spanFromRange } from './spans.ts';
import { mintSymbolId } from './symbol-id.ts';
import type { SyntacticSources } from './syntactic-cache.ts';
import { namedDeclarations } from './syntactic-internal.ts';
import { isRealDeclaration, nameAnchor, nodeKindLabel } from './syntactic-nodes.ts';

/** One addressable declaration on the surface, anchored on its name token. */
export type DeclSite = {
  rel: RepoRelPath;
  sf: ts.SourceFile;
  node: ts.Declaration;
  name: string;
  /** 0-based start of the name token — the anchor every symbol-addressed read funnels through. */
  anchor: number;
  /** 0-based end of the name token. Read off the name NODE, not `anchor + name.length`: a
   *  string-literal-named member (`'a-b'(){}`) has a name whose SOURCE is wider than its text, and a
   *  span built from the text length would prove a range that is not the name (§16 invariant 1). */
  nameEnd: number;
  /** An import / re-export re-mention of a name declared elsewhere: it has no body to print. */
  alias: boolean;
};

/** The surface, pinned for ONE op call: the parsed sources plus the per-file index over them.
 *  Pinned, because an op answering about several targets must see one state (§8) — and memoized,
 *  because re-indexing the whole surface per target is per-call work that scales with the repo (§1). */
export type DeclIndex = {
  readonly rootTag: string;
  /** The file a caller's `file` arg names, or `undefined` when it is not on the surface. */
  fileOf(file: string): { rel: RepoRelPath; sf: ts.SourceFile } | undefined;
  /** Every named declaration in one file, source-ordered. */
  declsOf(rel: RepoRelPath, sf: ts.SourceFile): readonly DeclSite[];
  /** Every declaration of `name` anywhere on the surface. */
  named(name: string): readonly DeclSite[];
};

export function createDeclIndex(
  root: string,
  sources: SyntacticSources,
  rootTag: string,
): DeclIndex {
  const perFile = new WeakMap<ts.SourceFile, readonly DeclSite[]>();
  const declsOf = (rel: RepoRelPath, sf: ts.SourceFile): readonly DeclSite[] => {
    const memo = perFile.get(sf);
    if (memo !== undefined) return memo;
    const built = indexFile(rel, sf);
    perFile.set(sf, built);
    return built;
  };
  return {
    rootTag,
    fileOf(file) {
      // Normalize through the SAME chokepoint the checker path's `absOf` uses (realpath + case-fold +
      // symlink policy), so `./src/x.ts`, an absolute path straight out of a Read, and a
      // differently-cased spelling on a case-insensitive volume all reach the one repo-relative key
      // the git listing branded. A raw `sources.get(file)` made the two modes disagree on one address.
      const minted = mintRepoRelPath(root, file);
      const rel = (minted.ok ? minted.path : file) as RepoRelPath;
      const sf = sources.get(rel);
      return sf === undefined ? undefined : { rel, sf };
    },
    declsOf,
    named(name) {
      const out: DeclSite[] = [];
      for (const [rel, sf] of sources) {
        for (const d of declsOf(rel, sf)) if (d.name === name) out.push(d);
      }
      return out;
    },
  };
}

function indexFile(rel: RepoRelPath, sf: ts.SourceFile): readonly DeclSite[] {
  const out: DeclSite[] = [];
  const seen = new Set<number>(); // one anchor counted once (a name may appear under several nodes)
  namedDeclarations(sf).forEach((nodes, name) => {
    for (const node of nodes) {
      const anchor = nameAnchor(node, sf);
      if (seen.has(anchor)) continue;
      seen.add(anchor);
      const nameNode = ts.getNameOfDeclaration(node);
      out.push({
        rel,
        sf,
        node,
        name,
        anchor,
        nameEnd: nameNode === undefined ? anchor + name.length : nameNode.getEnd(),
        alias: !isRealDeclaration(node),
      });
    }
  });
  return out.sort((a, b) => a.anchor - b.anchor); // source order → deterministic (cold == warm)
}

/** Does this node introduce a BINDING SCOPE — a region within which one name means one thing?
 *
 *  Every construct that binds names must be here, or `scopeOf` climbs past it and two declarations in
 *  two sibling regions read as one symbol. The non-obvious members are the ones that cost a defect: a
 *  `for`/`for-of`/`for-in` header and a `catch` clause each bind their own variable (two `for (let i…)`
 *  in one body are two symbols), and a FUNCTION binds its parameters (two functions' `p` parameters are
 *  not one symbol just because both functions sit in one block).
 *
 *  A variable-declaration list and its statement are deliberately absent: they sit BETWEEN a `const X`
 *  declarator and the region that really contains it. */
function isScopeContainer(node: ts.Node): boolean {
  return (
    ts.isSourceFile(node) ||
    ts.isModuleBlock(node) ||
    ts.isBlock(node) ||
    ts.isClassLike(node) ||
    ts.isInterfaceDeclaration(node) ||
    ts.isEnumDeclaration(node) ||
    ts.isTypeLiteralNode(node) ||
    ts.isObjectLiteralExpression(node) ||
    ts.isForStatement(node) ||
    ts.isForOfStatement(node) ||
    ts.isForInStatement(node) ||
    ts.isCatchClause(node) ||
    // The `switch` BODY, not its clauses: one `CaseBlock` is the block scope shared by every clause, so
    // two `let z` in two clauses of ONE switch collapse (TS rejects that code, so the premise holds)
    // while two separate `switch` statements are two scopes.
    ts.isCaseBlock(node) ||
    ts.isFunctionLike(node)
  );
}

function scopeNodeOf(node: ts.Node): ts.Node {
  for (let up: ts.Node | undefined = node.parent; up !== undefined; up = up.parent) {
    if (isScopeContainer(up)) return up;
  }
  return node;
}

/** The object an expando assignment (`Foo.bar = …`) hangs off, as source text.
 *
 *  An expando is NOT a scope binding, so scope identity cannot separate two of them: `Foo.bar` and
 *  `Baz.bar` at top level share the SourceFile and would read as one merged symbol. What separates them
 *  is the assignment TARGET, so it joins the scope key. Text, not a resolved symbol — resolving one
 *  would need the checker this path does without; two spellings of one object therefore read as two
 *  scopes, which errs toward a pick-list (an honest "you choose") rather than a false merge. Known and
 *  accepted in the same direction: two assignments to ONE object from inside two different arrow
 *  functions differ by enclosing scope, so they are a pick-list rather than a merge. */
function expandoTarget(node: ts.Node): string | undefined {
  if (!ts.isBinaryExpression(node)) return undefined;
  const lhs = node.left;
  if (!ts.isPropertyAccessExpression(lhs) && !ts.isElementAccessExpression(lhs)) return undefined;
  try {
    return lhs.expression.getText(node.getSourceFile());
  } catch {
    return undefined; // a synthetic node with no text — no key contribution, never a throw
  }
}

/** A declaration's binding identity, kept as PARTS rather than one blob so a refusal can say which part
 *  diverged. `scope` is a string (not the node) because two files' nodes must never compare equal — a
 *  candidate set can span files — and `pos`+`kind` is unique within one file's AST. */
type ScopeKey = { readonly scope: string; readonly target?: string };

function scopeKeyOf(site: DeclSite): ScopeKey {
  const scope = scopeNodeOf(site.node);
  const target = expandoTarget(site.node);
  return {
    scope: `${site.rel}|${scope.pos}|${scope.kind}`,
    ...(target === undefined ? {} : { target }),
  };
}

export function isTopLevel(site: DeclSite): boolean {
  return ts.isSourceFile(scopeNodeOf(site.node));
}

/** What separated a candidate set that did NOT collapse — so the message can name the cause that FIRED
 *  instead of a plausible one. Derived from WHICH PART of the scope key diverged, never re-inferred: the
 *  key has two parts and both can differ, so a two-valued guess mislabels the mixed case.
 *   - `'scope'` — the declarations bind in different regions;
 *   - `'expando-target'` — all are property assignments, on different objects, in ONE region;
 *   - `'expando-vs-plain'` — one is a property assignment and another is not, in one region (a
 *     `Foo.tag = 1` beside a `const tag`); calling THAT "different objects" names an object the second
 *     declaration does not have. */
export type RivalCause = 'scope' | 'expando-target' | 'expando-vs-plain';

/** One symbol (with the rest of its own declarations), or a set of candidates no address picked between.
 *
 *  `rivals` does NOT assert "different symbols": a scope boundary is what we OBSERVED, and it does not
 *  prove distinctness — two `declare global { interface Win }` blocks, two `namespace Ns` bodies, and a
 *  function-scoped `var` in two blocks are each ONE symbol declared in several regions. Proving that needs
 *  the checker this path does without, so the honest output is the observation plus the pick-list. */
export type Collapsed =
  | { one: DeclSite; merged: readonly DeclSite[] }
  | { rivals: readonly DeclSite[]; cause: RivalCause };

/** Apply the policy in this module's header to same-named real declarations.
 *
 *  A TOP-LEVEL group wins when one exists: that is the scope a name address means, and it is exactly
 *  what the checker path's `name+file` resolves — so the two paths agree rather than diverge. With no
 *  top-level group, a single nested scope still resolves (a lone method addressed by name is
 *  unambiguous, and answering it is a capability the checker path lacks); several are rivals. */
export function collapseByScope(real: readonly DeclSite[]): Collapsed | undefined {
  if (real.length === 0) return undefined;
  const top = real.filter(isTopLevel);
  const group = top.length > 0 ? top : real;
  const first = group[0];
  if (first === undefined) return undefined;
  const keys = group.map(scopeKeyOf);
  const scopes = new Set(keys.map((k) => k.scope));
  const targets = new Set(keys.map((k) => k.target));
  if (scopes.size === 1 && targets.size === 1) return { one: first, merged: group.slice(1) };
  // The cause is READ OFF the diverging part, not guessed from the scope nodes: a set holding one expando
  // and one plain declaration in the same region diverges on `target` too, and reporting that as
  // "different objects" names an object the plain declaration does not have (§3.6).
  const cause: RivalCause =
    scopes.size > 1 ? 'scope' : targets.has(undefined) ? 'expando-vs-plain' : 'expando-target';
  return { rivals: group, cause };
}

/** The declaration node whose text IS the body to print. We already HAVE the declaration node (it came
 *  from `getNamedDeclarations`), so there is nothing to walk up FOR — except where the node is narrower
 *  than the declaration an agent means: a `const X = …` declarator does not carry its own `export`
 *  keyword or trailing `;`, and a destructured binding (`const { d1 } = o`) is a single identifier whose
 *  meaning is the whole statement.
 *
 *  Deliberately NOT `declarationNodeOf` (the position-only walk `find_definition` uses): starting from an
 *  OFFSET it cannot know which declaration the offset belongs to, so for a declaration kind outside its
 *  list — a catch-clause variable, a parameter — it walks past the real declaration and returns the
 *  enclosing function, whose body then gets printed under the inner name. Given the node, that whole
 *  failure mode is unreachable. (The position-only path's own case is filed separately.) */
export function bodyNodeOf(node: ts.Declaration): ts.Node {
  // Climb out of a binding pattern to the declarator that owns it, then apply the declarator rule.
  let inner: ts.Node = node;
  while (
    ts.isBindingElement(inner) ||
    ts.isObjectBindingPattern(inner) ||
    ts.isArrayBindingPattern(inner)
  ) {
    const up: ts.Node | undefined = inner.parent;
    if (up === undefined) break;
    inner = up;
  }
  const list = inner.parent;
  if (ts.isVariableDeclaration(inner) && list !== undefined && ts.isVariableDeclarationList(list)) {
    const stmt = list.parent;
    // Only a STATEMENT lift: a `for (const x of …)` list's parent is the loop, and printing the loop
    // as the declaration of `x` is the very substitution this function exists to avoid.
    if (stmt !== undefined && ts.isVariableStatement(stmt)) return stmt;
  }
  return inner;
}

/** The proof-carrying view: the name-token span plus the WHOLE declaration span (the body — the point of
 *  this op), both built from the same SourceFile that produced the range. */
export function viewOf(site: DeclSite, rootTag: string): SymbolView {
  const span = spanFromRange(site.sf, site.rel, site.anchor, site.nameEnd);
  const body = bodyNodeOf(site.node);
  const decl = spanFromRange(
    site.sf,
    site.rel,
    body.getStart(site.sf),
    body.getEnd(),
    DECL_TEXT_CAP,
  );
  return {
    id: mintSymbolId(site.name, site.rel, span.line, span.col, rootTag),
    name: site.name,
    kind: nodeKindLabel(site.node),
    span,
    decl,
    provenance: 'syntactic',
  };
}

/** A paste-able SymbolId for a candidate in a pick-list. */
export function idOf(site: DeclSite, rootTag: string): string {
  const lc = site.sf.getLineAndCharacterOfPosition(site.anchor);
  return mintSymbolId(site.name, site.rel, lc.line + 1, lc.character + 1, rootTag);
}

export function lineOf(site: DeclSite): number {
  return site.sf.getLineAndCharacterOfPosition(site.anchor).line + 1;
}

export function colOf(site: DeclSite): number {
  return site.sf.getLineAndCharacterOfPosition(site.anchor).character + 1;
}
