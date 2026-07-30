// `source { syntactic: true }` — read a declaration's BODY without building a TypeScript program
// (t-229522). "Print the body of this declaration" is a SYNTACTIC question, and the no-program §10
// git-source surface that `search_symbol {syntactic:true}` / `symbols_overview` already ride answers
// it: this path never warms the LS.
//
// WHAT IT BUYS, measured (a 6101-file monorepo, box with RAM to spare). The checker path is not
// impossible there — a file-pinned `source` costs 839 MB / 4.5 s, a bare-name one 881 MB / 5.8 s, both
// within the default 4 GB — so this is an order-of-magnitude latency/heap win for a question that needs
// no checker, NOT a rescue from a refusal. Where it IS the difference between an answer and none: a
// BATCH. An engine serializes a batch's ops in one heap, so a `source` riding along with a reference
// fan-out (measured 5.2 GB live / ~30 s) dies as a PASSENGER of its neighbour; a call that builds no
// program has nothing to lose to it.
//
// WHAT IT IS NOT — the difference that decides the flag is opt-in, not a default. The default path
// resolves an address through the checker, which FOLLOWS it: a `file:line:col` on a reference returns
// the declaration it refers to, in another file. This path cannot follow anything — it prints the
// declaration ANCHORED at the address. So it answers only about DECLARATION positions, and says so
// where the address is not one (never the enclosing declaration in its place — that would answer a
// question nobody asked while looking like the answer). It also resolves no module specifier: an
// address landing on `import { X } from './y'` is reported as an alias site, not printed as X's body.
//
// SCOPE (the same honest scope as the sibling syntactic paths, t-515730): every git-tracked source
// file under the workspace root plus untracked-not-ignored ones — COMPLETE for declarations there and
// wider than the checker path in one respect (a file no tsconfig includes is scanned here), but a
// tsconfig `include`/`reference` reaching OUTSIDE the root is not. Every hit carries
// `provenance:'syntactic'`; the op states the scope on every answer.
//
// ONE declaration set for all five addressings (`symbolId` / `file+line+col` / `file+line` /
// `name+file` / `name`): the `getNamedDeclarations` set minus alias re-mentions — exactly the set
// `search_symbol {syntactic:true}` mints its SymbolIds from, so a handle from that search resolves
// here by construction. A same-named twin found in >1 file is a pick-list, never a silent pick.

import ts from 'typescript';
import type { RepoRelPath } from '../../core/brands.ts';
import type { HandleRebind, SymbolId } from '../../core/ids.ts';
import type { Result } from '../../core/result.ts';
import { fail, ok } from '../../common/result/construct.ts';
import { isOk } from '../../common/result/narrow.ts';
import { nameWithMore } from '../../common/truncate/name-with-more.ts';
import type { SymbolView } from './query-types.ts';
import type { TsTargetInput } from './resolve-target.ts';
import { DECL_TEXT_CAP, offsetOfLoc, spanFromRange } from './spans.ts';
import { deriveRootTag, mintSymbolId, parseTsSymbolId } from './symbol-id.ts';
import type { SyntacticCache, SyntacticSources } from './syntactic-cache.ts';
import {
  INTERNAL_UNAVAILABLE,
  namedDeclarations,
  namedDeclarationsAvailable,
} from './syntactic-internal.ts';
import { isRealDeclaration, nameAnchor, nodeKindLabel } from './syntactic-nodes.ts';
import { surfaceSources } from './syntactic-surface.ts';

/** One addressable declaration on the surface, anchored on its name token. */
type DeclSite = {
  rel: RepoRelPath;
  sf: ts.SourceFile;
  node: ts.Declaration;
  name: string;
  /** 0-based start of the name token — the anchor every symbol-addressed read funnels through. */
  anchor: number;
  /** An import / re-export re-mention of a name declared elsewhere: it has no body to print. */
  alias: boolean;
};

export type SyntacticDeclHit = {
  view: SymbolView;
  /** Further declarations of the same name in the SAME file (an overload set / merged declaration),
   *  as `file:line` — listed, never dropped (§3.4). */
  moreDeclarations?: readonly string[];
  rebind?: HandleRebind;
};

/** Resolved, or an honest miss. A miss may carry a §6 rebind signal (a cross-root handle). */
export type SyntacticDeclOutcome =
  | { resolved: SyntacticDeclHit }
  | { miss: string; rebind?: HandleRebind };

/** How many same-named candidates a pick-list prints before `+N more`. */
const CANDIDATE_PREVIEW = 8;

/** The declaration body at `target`, read off the no-program surface. `ToolFailure` only for a real
 *  tool failure (git, the @internal helper); an address that resolves to nothing is a `miss`. */
export function declarationSyntactic(
  root: string,
  target: TsTargetInput,
  cache: SyntacticCache,
): Result<SyntacticDeclOutcome> {
  if (!namedDeclarationsAvailable()) return fail(INTERNAL_UNAVAILABLE);
  const sources = surfaceSources(root, cache);
  if (!isOk(sources)) return fail(sources.failure);
  return ok(resolveOver(sources.data, deriveRootTag(root), target));
}

function resolveOver(
  sources: SyntacticSources,
  rootTag: string,
  target: TsTargetInput,
): SyntacticDeclOutcome {
  // Branch order mirrors the checker path's own dispatch (`resolveTarget`), so a call carrying both a
  // handle and a name resolves through the SAME field either way.
  if (target.symbolId !== undefined) return byHandle(sources, rootTag, target.symbolId);
  if (target.file !== undefined && target.line !== undefined) {
    return byPosition(sources, rootTag, target.file, target.line, target.col, target.name);
  }
  if (target.file !== undefined && target.name !== undefined) {
    return byNameInFile(sources, rootTag, target.name, target.file);
  }
  if (target.name !== undefined) return byName(sources, rootTag, target.name);
  return { miss: 'target needs symbolId, name, file+line (col optional), or name+file' };
}

// ── addressings ───────────────────────────────────────────────────────────────────────────────

function byPosition(
  sources: SyntacticSources,
  rootTag: string,
  file: string,
  line: number,
  col: number | undefined,
  name: string | undefined,
): SyntacticDeclOutcome {
  const sf = sources.get(file as RepoRelPath);
  if (sf === undefined) return { miss: notOnSurface(file) };
  const rel = file as RepoRelPath;
  const all = declsInFile(rel, sf);
  const onName = name === undefined ? all : all.filter((d) => d.name === name);
  if (col === undefined) {
    // `file+line` (a grep/editor paste): the declaration(s) whose name token starts on that line.
    const hits = onName.filter((d) => lineOf(sf, d.anchor) === line);
    return fromCandidates(hits, rootTag, () => noDeclarationAt(file, line, undefined));
  }
  const offset = offsetOfLoc(sf, line, col);
  if (offset === undefined) return { miss: `position ${line}:${col} is outside ${file}` };
  // Containment, not equality: the checker path accepts a column anywhere inside the name token, and
  // an address that works there must not fail here for pointing at the token's second character.
  const hits = onName.filter((d) => offset >= d.anchor && offset < d.anchor + d.name.length);
  return fromCandidates(hits, rootTag, () => noDeclarationAt(file, line, col));
}

function byNameInFile(
  sources: SyntacticSources,
  rootTag: string,
  name: string,
  file: string,
): SyntacticDeclOutcome {
  const sf = sources.get(file as RepoRelPath);
  if (sf === undefined) return { miss: notOnSurface(file) };
  const hits = declsInFile(file as RepoRelPath, sf).filter((d) => d.name === name);
  return fromCandidates(hits, rootTag, () => noSuchNameInFile(name, file));
}

function byName(sources: SyntacticSources, rootTag: string, name: string): SyntacticDeclOutcome {
  const hits: DeclSite[] = [];
  for (const [rel, sf] of sources) {
    for (const d of declsInFile(rel, sf)) if (d.name === name) hits.push(d);
  }
  const real = hits.filter((d) => !d.alias);
  const files = new Set(real.map((d) => d.rel));
  if (files.size > 1) {
    // The identity question a bare name cannot settle — and the scan is COMPLETE under the root, so
    // this really is >1 declaration, not a ranking artefact. The list IS the remedy: each candidate
    // prints as a paste-able SymbolId.
    const labels = real.map((d) => idOf(d, rootTag));
    return {
      miss: `${real.length} declarations named '${name}' in ${files.size} files (${nameWithMore(
        labels,
        CANDIDATE_PREVIEW,
      )}) — pass one of these SymbolIds, or name+file / file:line:col`,
    };
  }
  return fromCandidates(hits, rootTag, () => noSuchNameOnSurface(name));
}

function byHandle(sources: SyntacticSources, rootTag: string, id: string): SyntacticDeclOutcome {
  const decoded = parseTsSymbolId(id);
  if (!decoded.ok) return { miss: decoded.message };
  const { name, rel, line, col, rootTag: tag } = decoded.parsed;
  // Cross-root guard (§6): a handle minted elsewhere must never name-rebind onto a same-named symbol
  // in THIS repo — that binds it to a different symbol entirely.
  if (tag !== undefined && tag !== rootTag) {
    return {
      miss: `SymbolId '${id}' was minted in a different workspace root — re-search the symbol by name in this root (SymbolIds do not cross roots)`,
      rebind: {
        status: 'gone',
        from: id as SymbolId,
        reason: 'handle belongs to a different workspace root — re-search by name in the new root',
      },
    };
  }
  const sf = sources.get(rel);
  if (sf !== undefined) {
    const all = declsInFile(rel, sf).filter((d) => d.name === name);
    const offset = offsetOfLoc(sf, line, col);
    const atPosition =
      offset === undefined
        ? undefined
        : all.find((d) => offset >= d.anchor && offset < d.anchor + d.name.length);
    if (atPosition !== undefined) return fromCandidates([atPosition], rootTag, unreachable);
    // §6 step 1: the handle's OWN file. Several same-named declarations in one file are a MERGED
    // symbol (an overload set, `interface` + `namespace`) — TS rejects a non-mergeable duplicate — so
    // the first is that symbol's declaration, not a rival candidate.
    const moved = all.filter((d) => !d.alias)[0];
    if (moved !== undefined) return rebound(moved, rootTag, id, 'same file, moved position');
  }
  // §6 step 2: workspace-wide, over the whole surface.
  const elsewhere: DeclSite[] = [];
  for (const [otherRel, otherSf] of sources) {
    if (otherRel === rel) continue;
    for (const d of declsInFile(otherRel, otherSf)) {
      if (d.name === name && !d.alias) elsewhere.push(d);
    }
  }
  const files = new Set(elsewhere.map((d) => d.rel));
  if (files.size === 1) {
    const sole = elsewhere[0];
    if (sole !== undefined) return rebound(sole, rootTag, id, `moved to ${sole.rel}`);
  }
  if (files.size > 1) {
    return {
      miss: `'${name}' (handle ${id}) is no longer at its recorded position, and ${elsewhere.length} declarations of that name exist in ${files.size} other files (${nameWithMore(
        elsewhere.map((d) => idOf(d, rootTag)),
        CANDIDATE_PREVIEW,
      )}) — pick one rather than have the handle rebound to a guess`,
    };
  }
  // NO `{status:'gone'}`: §6 scopes that claim to "absent in this workspace root", and this scan does
  // not cover a tsconfig include reaching OUTSIDE the root. Asserting removal off a surface that
  // cannot see there would be exactly the §3.4 lie in its most damaging form (the agent's whole chain
  // rests on it). Report what we did see, and where the answer still lives.
  return {
    miss: `'${name}' (handle ${id}) is not in the scanned git source surface under the workspace root — this is NOT proof it is gone (an outside-root tsconfig include is not scanned here); drop syntactic:true to resolve it through the checker`,
  };
}

// ── shared plumbing ───────────────────────────────────────────────────────────────────────────

/** Every named declaration in one file, anchored on its name token, aliases flagged. One pass per
 *  file; the SourceFile itself is the memoized surface parse, so this is never a re-parse. */
function declsInFile(rel: RepoRelPath, sf: ts.SourceFile): DeclSite[] {
  const out: DeclSite[] = [];
  const seen = new Set<number>(); // one anchor counted once (a name may appear under several nodes)
  namedDeclarations(sf).forEach((nodes, name) => {
    for (const node of nodes) {
      const anchor = nameAnchor(node, sf);
      if (seen.has(anchor)) continue;
      seen.add(anchor);
      out.push({ rel, sf, node, name, anchor, alias: !isRealDeclaration(node) });
    }
  });
  return out.sort((a, b) => a.anchor - b.anchor); // source order → deterministic (cold == warm)
}

/** Turn candidates at one address into an outcome: prefer a real declaration, list the rest, and
 *  refuse to print an alias site as a body. */
function fromCandidates(
  hits: readonly DeclSite[],
  rootTag: string,
  onEmpty: () => string,
): SyntacticDeclOutcome {
  if (hits.length === 0) return { miss: onEmpty() };
  const real = hits.filter((d) => !d.alias);
  const sole = real[0];
  if (sole === undefined) {
    // Only alias re-mentions here. This is the routine case for a handle minted by
    // `search_symbol {syntactic:true}`, which returns import/re-export sites too — so it gets a
    // pointed remedy rather than a bare "not found". Resolving the module specifier ourselves would
    // be a second module-resolution oracle, which this path deliberately is not.
    const at = hits[0];
    const where = at === undefined ? '' : ` at ${at.rel}:${lineOf(at.sf, at.anchor)}`;
    return {
      miss: `${hits[0]?.name ?? 'this name'}${where} is an import / re-export re-mention, not a declaration — there is no body here. The syntactic path resolves no module specifier (that needs the checker): re-address at the declaration (search_symbol ranks real declarations first), or drop syntactic:true.`,
    };
  }
  const more = real.slice(1).map((d) => `${d.rel}:${lineOf(d.sf, d.anchor)}`);
  return {
    resolved: {
      view: viewOf(sole, rootTag),
      ...(more.length > 0 ? { moreDeclarations: more } : {}),
    },
  };
}

function rebound(
  site: DeclSite,
  rootTag: string,
  from: string,
  what: string,
): SyntacticDeclOutcome {
  const view = viewOf(site, rootTag);
  return {
    resolved: {
      view,
      rebind: {
        status: 'rebound',
        from: from as SymbolId,
        to: {
          id: view.id as SymbolId,
          name: view.name,
          kind: view.kind,
          loc: { file: site.rel, line: view.span.line, col: view.span.col },
        },
        proof: view.span,
        // A name/kind match proves LOCATION, not identity (§6) — never `certain`.
        confidence: 'partial',
        note: `'${site.name}' (${view.kind}) is now at ${site.rel}:${view.span.line}:${view.span.col} — ${what}; structural continuity not proven`,
      },
    },
  };
}

/** The declaration node whose text IS the body to print. We already HAVE the declaration node (it came
 *  from `getNamedDeclarations`), so there is nothing to walk up FOR — except the one case where the
 *  node is narrower than the declaration an agent means: a `const X = …` declarator does not carry its
 *  own `export` keyword or trailing `;`, both of which live on the enclosing `VariableStatement`.
 *
 *  Deliberately NOT `declarationNodeOf` (the position-only walk `find_definition` uses): starting from
 *  an OFFSET it cannot know which declaration the offset belongs to, so for a declaration kind outside
 *  its list — a catch-clause variable, a parameter — it walks past the real declaration and returns the
 *  enclosing function, whose body then gets printed under the inner name. Given the node, that whole
 *  failure mode is unreachable. (The position-only path's own case is filed separately.) */
function bodyNodeOf(node: ts.Declaration): ts.Node {
  const list = node.parent;
  if (ts.isVariableDeclaration(node) && list !== undefined && ts.isVariableDeclarationList(list)) {
    const stmt = list.parent;
    // Only a STATEMENT lift: a `for (const x of …)` list's parent is the loop, and printing the loop
    // as the declaration of `x` is the very substitution this function exists to avoid.
    if (stmt !== undefined && ts.isVariableStatement(stmt)) return stmt;
  }
  return node;
}

/** The proof-carrying view: the name-token span plus the WHOLE declaration span (the body — the
 *  point of this op), built from the same SourceFile that produced the range. */
function viewOf(site: DeclSite, rootTag: string): SymbolView {
  const span = spanFromRange(site.sf, site.rel, site.anchor, site.anchor + site.name.length);
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

function idOf(site: DeclSite, rootTag: string): string {
  const lc = site.sf.getLineAndCharacterOfPosition(site.anchor);
  return mintSymbolId(site.name, site.rel, lc.line + 1, lc.character + 1, rootTag);
}

function lineOf(sf: ts.SourceFile, offset: number): number {
  return sf.getLineAndCharacterOfPosition(offset).line + 1;
}

// ── miss messages (each names what this path cannot do, and where the answer is) ───────────────

function notOnSurface(file: string): string {
  return `${file} is not in the scanned git source surface — the syntactic path scans git-tracked (plus untracked-not-ignored) source under the workspace root, so a gitignored or outside-root file is not there; drop syntactic:true for the type-verified path`;
}

function noDeclarationAt(file: string, line: number, col: number | undefined): string {
  const at = col === undefined ? `${file}:${line}` : `${file}:${line}:${col}`;
  return `no declaration is anchored at ${at} — the syntactic path prints the declaration AT an address and cannot follow a reference to its definition (that needs the checker). Pass the declaration's own position, or drop syntactic:true.`;
}

function noSuchNameInFile(name: string, file: string): string {
  return `no declaration named '${name}' is anchored in ${file} by the syntactic scan — check the name/file, or pass file:line:col. NOTE: this is NOT proof of absence — a computed / string-named / destructured binding is declared yet carries no plain identifier for this scan to anchor.`;
}

function noSuchNameOnSurface(name: string): string {
  return `no declaration named '${name}' in git-tracked source under the workspace root. An outside-root tsconfig include/reference is not scanned here — drop syntactic:true for those.`;
}

/** A single already-located candidate can never be empty; the callback exists for the general case. */
function unreachable(): string {
  return 'no declaration at the resolved position';
}
