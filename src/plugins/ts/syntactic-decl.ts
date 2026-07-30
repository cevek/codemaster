// `source { syntactic: true }` — read a declaration's BODY without building a TypeScript program
// (t-229522). "Print the body of this declaration" is a SYNTACTIC question, and the no-program §10
// source surface that `search_symbol {syntactic:true}` / `symbols_overview` already ride answers
// it: this path never warms the LS. The declaration index and the candidate-collapse policy live in
// `syntactic-decl-index.ts`; this module owns only the five ADDRESSINGS and what a miss says.
//
// WHAT IT BUYS, measured on one 6101-file monorepo. The checker path is not impossible there — a
// `source` costs ~0.9 GB (parse+bind of the primary is 839–881 MB) and a few seconds, within a default
// 4 GB heap — so this is a large heap+latency saving on a question that needs no checker, NOT a rescue
// from a refusal. Where it IS the difference between an answer and none: a BATCH. An engine serializes a
// batch's ops in one heap, and `find_usages` on that repo takes ~5.2 GB live under ANY addressing and
// dies in the checker phase — so a `source` riding along dies as its PASSENGER, while a call that builds
// no program has nothing to lose to it.
//
// WHAT IT IS NOT — the difference that decides the flag is opt-in, not a default. The default path
// resolves an address through the checker, which FOLLOWS it: a `file:line:col` on a reference returns
// the declaration it refers to, in another file. This path cannot follow anything — it prints the
// declaration ANCHORED at the address. So it answers only about DECLARATION positions, and says so
// where the address is not one (never the enclosing declaration in its place — that would answer a
// question nobody asked while looking like the answer). It also resolves no module specifier: an
// address landing on `import { X } from './y'` is reported as an alias site, not printed as X's body.
//
// SCOPE: the shared `SYNTACTIC_SCOPE` (syntactic-scope.ts), which the op states on every answer. Every
// hit carries `provenance:'syntactic'`.
//
// ONE declaration set for all five addressings (`symbolId` / `file+line+col` / `file+line` /
// `name+file` / `name`): the same `getNamedDeclarations` nodes the syntactic search mints its ids from,
// with alias re-mentions kept but flagged. So a handle that search minted for a REAL declaration
// resolves here; one it minted for an ALIAS site comes back as an explicit miss, because there is no
// body at an import — the chain is honest, not seamless.

import type { HandleRebind, SymbolId } from '../../core/ids.ts';
import type { Result } from '../../core/result.ts';
import { fail, ok } from '../../common/result/construct.ts';
import { isOk } from '../../common/result/narrow.ts';
import type { Deadline } from '../../common/async/deadline.ts';
import { nameWithMore } from '../../common/truncate/name-with-more.ts';
import type { SymbolView } from './query-types.ts';
import type { TsTargetInput } from './resolve-target.ts';
import { offsetOfLoc } from './spans.ts';
import { deriveRootTag, parseTsSymbolId } from './symbol-id.ts';
import type { SyntacticCache } from './syntactic-cache.ts';
import { INTERNAL_UNAVAILABLE, namedDeclarationsAvailable } from './syntactic-internal.ts';
import { surfaceSources } from './syntactic-surface.ts';
import {
  colOf,
  createDeclIndex,
  collapseByScope,
  idOf,
  lineOf,
  viewOf,
  type DeclIndex,
  type DeclSite,
  type RivalCause,
} from './syntactic-decl-index.ts';
import { missingFileReason } from './syntactic-decl-miss.ts';

export type SyntacticDeclHit = {
  view: SymbolView;
  /** The symbol's OTHER declarations — same name, same scope, so genuinely one merged symbol (an
   *  overload set, `interface` + `namespace`) — as `file:line`. A same-named declaration in a DIFFERENT
   *  scope is never listed here: it is a different symbol, and the address that could not choose between
   *  them returned a pick-list instead. */
  moreDeclarations?: readonly string[];
  rebind?: HandleRebind;
};

/** Resolved, or an honest miss. A miss may carry a §6 rebind signal (a cross-root handle). */
export type SyntacticDeclOutcome =
  | { resolved: SyntacticDeclHit }
  | { miss: string; rebind?: HandleRebind };

/** One answer per target, plus the honest flag when the wall-clock budget cut the loop short. */
export type SyntacticDeclBatch = {
  outcomes: readonly SyntacticDeclOutcome[];
  timedOut?: true;
};

/** How many same-named candidates a pick-list prints before `+N more`. */
const CANDIDATE_PREVIEW = 8;

/** The declaration bodies at `targets`, read off the no-program surface. The surface is resolved ONCE
 *  and shared by every target (§8: one answer, one state — per-target resolution could assemble one
 *  reply over two different surfaces, and would re-take the repo fingerprint per target). `ToolFailure`
 *  only for a real tool failure (git, the @internal helper); an address that resolves to nothing is a
 *  per-target `miss`. */
export function declarationsSyntactic(
  root: string,
  targets: readonly TsTargetInput[],
  cache: SyntacticCache,
  deadline?: Deadline,
): Result<SyntacticDeclBatch> {
  if (!namedDeclarationsAvailable()) return fail(INTERNAL_UNAVAILABLE);
  const surface = surfaceSources(root, cache);
  if (!isOk(surface)) return fail(surface.failure);
  const index = createDeclIndex(root, surface.data.sources, deriveRootTag(root));
  const outcomes: SyntacticDeclOutcome[] = [];
  for (const target of targets) {
    // §19 loop-boundary poll: each target's bare-name arm walks the whole surface, so the budget is
    // checked between targets rather than trusted to be small.
    if (deadline?.expired() === true) return ok({ outcomes, timedOut: true });
    outcomes.push(resolveOne(root, index, target));
  }
  return ok({ outcomes });
}

function resolveOne(root: string, index: DeclIndex, target: TsTargetInput): SyntacticDeclOutcome {
  // Branch order mirrors the checker path's own dispatch (`resolveTarget`), so a call carrying both a
  // handle and a name resolves through the SAME field either way.
  if (target.symbolId !== undefined) return byHandle(root, index, target.symbolId);
  if (target.file !== undefined && target.line !== undefined) {
    return byPosition(root, index, target.file, target.line, target.col, target.name);
  }
  if (target.file !== undefined && target.name !== undefined) {
    return byNameInFile(root, index, target.name, target.file);
  }
  if (target.name !== undefined) return byName(index, target.name);
  return { miss: 'target needs symbolId, name, file+line (col optional), or name+file' };
}

// ── addressings ───────────────────────────────────────────────────────────────────────────────

function byPosition(
  root: string,
  index: DeclIndex,
  file: string,
  line: number,
  col: number | undefined,
  name: string | undefined,
): SyntacticDeclOutcome {
  const found = index.fileOf(file);
  if (found === undefined) return { miss: missingFileReason(root, file) };
  const all = index.declsOf(found.rel, found.sf);
  if (col === undefined) {
    // `file+line` (a grep/editor paste): the declarations whose name token starts on that line. `name`,
    // when given, scopes the line to it — mirroring the checker path's `resolveByLine`.
    const onName = name === undefined ? all : all.filter((d) => d.name === name);
    const hits = onName.filter((d) => lineOf(d) === line);
    const sole = hits[0];
    if (sole === undefined) return { miss: noDeclarationAt(file, line, undefined) };
    if (hits.length > 1) return { miss: lineIsAmbiguous(file, line, hits, name) };
    return fromCandidates(
      [sole],
      index.rootTag,
      () => noDeclarationAt(file, line, undefined),
      true,
    );
  }
  const offset = offsetOfLoc(found.sf, line, col);
  if (offset === undefined) return { miss: `position ${line}:${col} is outside ${file}` };
  // Containment, not equality: the checker path accepts a column anywhere inside the name token, and an
  // address that works there must not fail here for pointing at the token's second character. `name` is
  // NOT applied — a position already identifies one declaration, and the checker path ignores it too, so
  // filtering here would miss where the sibling mode resolves.
  const hits = all.filter((d) => offset >= d.anchor && offset < d.nameEnd);
  return fromCandidates(hits, index.rootTag, () => noDeclarationAt(file, line, col), true);
}

function byNameInFile(
  root: string,
  index: DeclIndex,
  name: string,
  file: string,
): SyntacticDeclOutcome {
  const found = index.fileOf(file);
  if (found === undefined) return { miss: missingFileReason(root, file) };
  const hits = index.declsOf(found.rel, found.sf).filter((d) => d.name === name);
  return fromCandidates(hits, index.rootTag, () => noSuchNameInFile(name, file), true);
}

function byName(index: DeclIndex, name: string): SyntacticDeclOutcome {
  // No cross-file special case: two files are two scope KEYS (the key is rooted at the file), so
  // `collapseByScope` already reports them as rivals — over the very set it describes. A separate branch
  // here derived its cause from one set and printed another, which is how a description comes to name a
  // subset of the candidates it lists. The scan is COMPLETE under the root, so a pick-list here really is
  // >1 declaration, never a ranking artefact.
  // `false`: a bare name pinned nothing, so a nested candidate is a rival, not a runner-up.
  return fromCandidates(index.named(name), index.rootTag, () => noSuchNameOnSurface(name), false);
}

function byHandle(root: string, index: DeclIndex, id: string): SyntacticDeclOutcome {
  const decoded = parseTsSymbolId(id);
  if (!decoded.ok) return { miss: decoded.message };
  const { name, rel, line, col, rootTag: tag } = decoded.parsed;
  // Cross-root guard (§6): a handle minted elsewhere must never name-rebind onto a same-named symbol in
  // THIS repo — that binds it to a different symbol entirely.
  if (tag !== undefined && tag !== index.rootTag) {
    return {
      miss: `SymbolId '${id}' was minted in a different workspace root — re-search the symbol by name in this root (SymbolIds do not cross roots)`,
      rebind: {
        status: 'gone',
        from: id as SymbolId,
        reason: 'handle belongs to a different workspace root — re-search by name in the new root',
      },
    };
  }
  const found = index.fileOf(rel);
  if (found !== undefined) {
    const all = index.declsOf(found.rel, found.sf).filter((d) => d.name === name);
    const offset = offsetOfLoc(found.sf, line, col);
    const atPosition =
      offset === undefined ? undefined : all.find((d) => offset >= d.anchor && offset < d.nameEnd);
    if (atPosition !== undefined) {
      return fromCandidates([atPosition], index.rootTag, () => handleNotOnSurface(name, id), true);
    }
    // §6 step 1: the handle's OWN file. Same collapse policy as every other addressing — same-scope
    // declarations are the held symbol's own merged set, while two same-named declarations in DIFFERENT
    // scopes are rivals, and rebinding a handle onto one of those would claim a move that never happened.
    const own = collapseByScope(
      all.filter((d) => !d.alias),
      true,
    );
    if (own !== undefined) {
      if ('rivals' in own) {
        return { miss: handleRivals(name, id, own.rivals, index.rootTag, own.cause) };
      }
      return rebound(own, index.rootTag, id, 'same file, moved position');
    }
  }
  // §6 step 2: workspace-wide, over the whole surface.
  const elsewhere = index.named(name).filter((d) => !d.alias && d.rel !== rel);
  // ONE `collapseByScope` decides both arms: a set it does NOT call rivals shares one scope key, hence
  // one file, so it is the moved symbol; anything else is a pick-list described by the same function the
  // name path uses. A separate `files.size === 1` gate plus a trailing fallback were two spellings of
  // that one condition, and the fallback was then unreachable — untestable by construction.
  // The handle named a file, and this arm is about the symbol having MOVED out of it — so the pin still
  // holds for the file it landed in.
  const collapsed = collapseByScope(elsewhere, true);
  if (collapsed !== undefined) {
    if (!('rivals' in collapsed)) {
      return rebound(collapsed, index.rootTag, id, `moved to ${collapsed.one.rel}`);
    }
    return { miss: handleRivals(name, id, collapsed.rivals, index.rootTag, collapsed.cause) };
  }
  // NO `{status:'gone'}` for a name merely absent from the surface: §6 scopes that claim to "absent in
  // this workspace root", and this scan does not cover a tsconfig include reaching OUTSIDE the root.
  // Asserting removal off a surface that cannot see there would be the §3.4 lie in its most damaging
  // form (the agent's whole chain rests on it). A cross-root handle above is different — §6 sanctions
  // `gone` there, because the handle itself proves it belongs to another root.
  return { miss: handleNotOnSurface(name, id) };
}

// ── shared plumbing ───────────────────────────────────────────────────────────────────────────

/** Turn candidates at one address into an outcome: refuse to print an alias site as a body, and apply
 *  the collapse policy so a pick among rivals is never silent. */
function fromCandidates(
  hits: readonly DeclSite[],
  rootTag: string,
  onEmpty: () => string,
  /** Did the caller pin a file? Only then may a top-level candidate outrank a nested one. */
  filePinned: boolean,
): SyntacticDeclOutcome {
  if (hits.length === 0) return { miss: onEmpty() };
  const collapsed = collapseByScope(
    hits.filter((d) => !d.alias),
    filePinned,
  );
  if (collapsed === undefined) {
    // Only alias re-mentions here. This is the routine case for a handle minted by
    // `search_symbol {syntactic:true}`, which returns import/re-export sites too — so it gets a pointed
    // remedy rather than a bare "not found". Resolving the module specifier ourselves would be a second
    // module-resolution oracle, which this path deliberately is not.
    const at = hits[0];
    const where = at === undefined ? '' : ` at ${at.rel}:${lineOf(at)}`;
    return {
      miss: `${at?.name ?? 'this name'}${where} is an import / re-export re-mention, not a declaration — there is no body here. The syntactic path resolves no module specifier (that needs the checker): re-address at the declaration (search_symbol ranks real declarations first), or drop syntactic:true.`,
    };
  }
  if ('rivals' in collapsed) {
    const first = collapsed.rivals[0];
    const description = rivalsDescription(
      first?.name ?? 'this name',
      collapsed.rivals,
      rootTag,
      collapsed.cause,
    );
    return { miss: `${description}, so ${PICK_ONE}` };
  }
  return {
    resolved: {
      view: viewOf(collapsed.one, rootTag),
      ...(collapsed.merged.length > 0
        ? { moreDeclarations: collapsed.merged.map((d) => `${d.rel}:${lineOf(d)}`) }
        : {}),
    },
  };
}

function rebound(
  collapsed: { one: DeclSite; merged: readonly DeclSite[] },
  rootTag: string,
  from: string,
  what: string,
): SyntacticDeclOutcome {
  const view = viewOf(collapsed.one, rootTag);
  return {
    resolved: {
      view,
      ...(collapsed.merged.length > 0
        ? { moreDeclarations: collapsed.merged.map((d) => `${d.rel}:${lineOf(d)}`) }
        : {}),
      rebind: {
        status: 'rebound',
        from: from as SymbolId,
        to: {
          id: view.id as SymbolId,
          name: view.name,
          kind: view.kind,
          loc: { file: collapsed.one.rel, line: view.span.line, col: view.span.col },
        },
        proof: view.span,
        // A name/kind match proves LOCATION, not identity (§6) — never `certain`.
        confidence: 'partial',
        note: `'${collapsed.one.name}' (${view.kind}) is now at ${collapsed.one.rel}:${view.span.line}:${view.span.col} — ${what}; structural continuity not proven`,
      },
    },
  };
}

// ── miss messages (each names what this path cannot do, and where the answer is) ───────────────

const MERGE_CAVEAT =
  'this path cannot tell separate symbols from ONE symbol declared in several places (a namespace / declare-global merge, a function-scoped var; that needs the checker)';

/** The remedy, stated once wherever a pick-list is the answer. Shared so a COMPOSED message cannot carry
 *  it twice, or carry a caller's own paraphrase of it beside it. */
const PICK_ONE = 'pick the one you mean: pass one of these SymbolIds, or name+file / file:line:col';

/** WHAT was observed, and the caveat that observation licenses.
 *
 *  The MERGE caveat rides only the region-based observations: a `namespace` / `declare global` merge and a
 *  function-scoped `var` are ways ONE symbol occupies several regions, so citing them beside two
 *  assignments on different objects would explain the answer with an irrelevance. And where a member is
 *  NOT a property assignment, the caveat may not speak of "which object each belongs to" — one of them has
 *  no object, which is the fabricated-cause defect one clause further along. Both facts of a mixed set are
 *  reported when both hold: a 2-and-1 set is on different objects AND has a member on no object, and
 *  stating only one of those is the understatement a single label forced. */
function describeRivalCause(
  cause: RivalCause,
  fileCount: number,
): { text: string; caveat: string } {
  if (fileCount > 1) return { text: `in ${fileCount} files`, caveat: MERGE_CAVEAT };
  if (cause.kind === 'scope') {
    return { text: 'in different scopes of one file', caveat: MERGE_CAVEAT };
  }
  // The LEAD must be true of every member, so `plain` belongs in it: a lead saying "as property
  // assignments" over a set containing a plain `const` is false, and contradicting it one clause later
  // does not repair it. `objects` counts DISTINCT objects, never members — three assignments over two
  // objects is "on 2 distinct objects", and phrasing it as a bare count reads as "2 of them".
  const objects = `on ${cause.objects} distinct object${cause.objects === 1 ? '' : 's'} (as written)`;
  const text = cause.plain
    ? `in one scope of one file — some as property assignments ${objects}, and at least one not a property assignment at all`
    : `as property assignments ${objects}, in one scope of one file`;
  return {
    text,
    caveat: cause.plain
      ? 'this path resolves neither which object a property assignment belongs to nor whether the others are the same symbol (that needs the checker)'
      : 'this path does not resolve which object each belongs to (that needs the checker)',
  };
}

/** Candidates no address has chosen between; the list IS the remedy.
 *
 *  It states what was OBSERVED and never a verdict on identity. Neither observation proves distinctness:
 *  across files, a `declare module` augmentation is one symbol declared twice; within one file, so are two
 *  `declare global` blocks, two `namespace` bodies, and a function-scoped `var` in two blocks. Telling
 *  those from two symbols needs the checker this path does without, so claiming "these are different
 *  symbols" would be a verdict off an observation that does not carry it. Returns the DESCRIPTION only —
 *  each caller appends the remedy once, in its own voice. */
function rivalsDescription(
  name: string,
  rivals: readonly DeclSite[],
  rootTag: string,
  cause: RivalCause,
): string {
  const ids = nameWithMore(
    rivals.map((d) => idOf(d, rootTag)),
    CANDIDATE_PREVIEW,
  );
  const fileCount = new Set(rivals.map((d) => d.rel)).size;
  const observed = describeRivalCause(cause, fileCount);
  return `${rivals.length} declarations named '${name}' ${observed.text} (${ids}) — ${observed.caveat}`;
}

/** The same candidate set, reached through a stale handle. It DELEGATES the description to
 *  `rivalsDescription` rather than wording its own: stating a cause here made the two addressings
 *  contradict each other about the same two declarations (the handle path called an expando pair a scope
 *  boundary, and a cross-file pair "different scopes"), and it dropped the caveat that the set may be one
 *  symbol. One set, one description, one remedy. */
function handleRivals(
  name: string,
  id: string,
  rivals: readonly DeclSite[],
  rootTag: string,
  cause: RivalCause,
): string {
  return `'${name}' (handle ${id}) is not at its recorded position, and there are ${rivalsDescription(
    name,
    rivals,
    rootTag,
    cause,
  )}, so ${PICK_ONE} — rather than have the handle rebound to a guess`;
}

function handleNotOnSurface(name: string, id: string): string {
  return `'${name}' (handle ${id}) is not in the scanned source surface under the workspace root — this is NOT proof it is gone (an outside-root tsconfig include is not scanned here); drop syntactic:true to resolve it through the checker`;
}

function noDeclarationAt(file: string, line: number, col: number | undefined): string {
  const at = col === undefined ? `${file}:${line}` : `${file}:${line}:${col}`;
  return `no declaration is anchored at ${at} — the syntactic path prints the declaration AT an address and cannot follow a reference to its definition (that needs the checker). Pass the declaration's own position, or drop syntactic:true.`;
}

/** Several declarations anchored on one line — mirroring the checker path's `resolveByLine`, the list is
 *  the remedy (the agent picks a column out of it), never a silent pick of the first. */
function lineIsAmbiguous(
  file: string,
  line: number,
  hits: readonly DeclSite[],
  name: string | undefined,
): string {
  const labels = hits.map((d) => `${d.name} at col ${colOf(d)}`);
  const overflow =
    hits.length > CANDIDATE_PREVIEW && name === undefined
      ? ", or add 'name' to filter the line"
      : '';
  return `${file}:${line} has ${hits.length} declarations (${nameWithMore(
    labels,
    CANDIDATE_PREVIEW,
  )}) — pass file:line:col to pick one${overflow}`;
}

function noSuchNameInFile(name: string, file: string): string {
  // The limit stated here is the one that HOLDS: the index keys a declaration by the name TS can read off
  // it statically. A string-literal or `[Symbol.x]` name IS readable and does anchor — naming those as
  // blind spots steered an agent off a call that works, the same wrong-cause defect as a guessed file
  // reason (§3.6). What genuinely has no key is a name only computable at runtime.
  return `no declaration named '${name}' is anchored in ${file} by the syntactic scan — check the name/file (a member is indexed under its KEY, so \`[Symbol.iterator]\` is reachable as 'iterator' and \`'a-b'\` as 'a-b'), or pass file:line:col. NOTE: this is NOT proof of absence — a declaration whose name is computed at runtime (\`[key]\`, \`[\${expr}]\`) is indexed under no name at all, so no name can reach it; address it by position.`;
}

function noSuchNameOnSurface(name: string): string {
  return `no declaration named '${name}' in the scanned source surface under the workspace root. An outside-root tsconfig include/reference is not scanned here — drop syntactic:true for those.`;
}
