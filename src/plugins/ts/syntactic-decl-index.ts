// The declaration INDEX and the candidate-collapse POLICY behind `source { syntactic: true }`
// (t-229522). Split from the addressing dispatch (`syntactic-decl.ts`) because it answers a different
// question: not "where did the agent point" but "given N declarations that share a name, which of them
// are ONE symbol and which are rivals" — the question whose wrong answer is a silent pick.
//
// THE POLICY, and why scope is the discriminator. TypeScript rejects a non-mergeable duplicate WITHIN
// one scope, so several same-named declarations in the SAME scope are one symbol seen several times (an
// overload set, `interface` + `namespace`). Two DIFFERENT scopes are two symbols that merely share a
// name — `class A { run(){} }` and `class B { run(){} }`, or a `const tmp` in each of two functions —
// and this surface is full of them, because it indexes nested and member declarations too, not just the
// top-level ones the checker path's name resolution anchors. Picking one of those and calling the other
// "another definition of it" asserts a merge relationship the set cannot support (§3.4/§6): so rivals
// come back as a pick-list, and only a same-scope set collapses.

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

/** The scope a declaration lives in — the node whose body/statement list holds it. Identity of this
 *  node is the merge test: same scope ⇒ one symbol, different scopes ⇒ rivals. */
function scopeOf(node: ts.Node): ts.Node {
  for (let up: ts.Node | undefined = node.parent; up !== undefined; up = up.parent) {
    // A variable-declaration list and its statement are not scopes — they sit between a `const X`
    // declarator and the scope that really contains it.
    if (
      ts.isSourceFile(up) ||
      ts.isModuleBlock(up) ||
      ts.isBlock(up) ||
      ts.isClassLike(up) ||
      ts.isInterfaceDeclaration(up) ||
      ts.isEnumDeclaration(up) ||
      ts.isTypeLiteralNode(up) ||
      ts.isObjectLiteralExpression(up)
    ) {
      return up;
    }
  }
  return node;
}

export function isTopLevel(site: DeclSite): boolean {
  return ts.isSourceFile(scopeOf(site.node));
}

/** One symbol (with the rest of its own declarations), or a set of rivals no address has picked between.
 *  `rivals` is the honest answer for a name that denotes different symbols in different scopes. */
export type Collapsed =
  | { one: DeclSite; merged: readonly DeclSite[] }
  | { rivals: readonly DeclSite[] };

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
  const scopes = new Set(group.map((d) => scopeOf(d.node)));
  const first = group[0];
  if (first === undefined) return undefined;
  if (scopes.size > 1) return { rivals: group };
  return { one: first, merged: group.slice(1) };
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
