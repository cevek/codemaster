// The candidate list a bare `{name}` returns when it resolves to more than one declaration.
// Its whole job is that the agent's NEXT call hits the symbol it meant: an ambiguity report that
// enumerates re-export specifiers while the real declaration is missing steers the agent to pin an
// ALIAS (§3.4 — a target that is not shown cannot be chosen). So three rules live here:
//
//   1. Collapse by DEFINITION — the barrel chain (`export { X } from './x'`) is one symbol seen N
//      times; within one definition a real declaration always beats the alias that points at it.
//      An alias the ANSWERING program cannot resolve is re-asked across the other built programs
//      that contain its file, so a loose-root monorepo's member `paths` still prove the collapse.
//   2. Rank declaration-first — an alias is never the default pick.
//   3. Count honestly — the enumerated set is capped for readability, and both the display cap and
//      the search budget are disclosed (`… N more`, `≥N`), never a silently short list.
//
// Each entry is printed as its canonical SymbolId (which CONTAINS file:line:col, so nothing is lost)
// so the agent copies one verbatim into `symbolId`; an alias also carries the declaration it
// resolves to, so picking one is an informed choice rather than a guess.

import ts from 'typescript';
import type { RepoRelPath } from '../../core/brands.ts';
import type { TsProjectHost } from './ls-host.ts';
import type { TsProgram } from './program/queryable-program.ts';
import { ALIAS_KIND, type SymbolView } from './query-types.ts';
import { offsetOfLoc } from './spans.ts';

/** How many candidates the message enumerates. Above this the tail is `… N more` (§3.4) — a
 *  barrel-heavy name resolves to dozens, and a multi-KB failure message buries its own verdict
 *  (§12 verdict-first). Ranking puts every real declaration ahead of the aliases, so the shown
 *  head is the part the agent actually picks from. */
const SHOWN_CANDIDATES = 8;

/** One distinct declaration behind an ambiguous name. `target` is present only for an ALIAS whose
 *  definition resolves elsewhere — the declaration it stands for, so the agent sees where the
 *  handle leads before pinning it. */
export type AmbiguityCandidate = {
  view: SymbolView;
  target?: { file: RepoRelPath; line: number; col: number };
};

/** Collapse same-named navto candidates that resolve to ONE declaration (a decl + its
 *  `export { X }` re-mention, or a whole barrel chain), then rank real declarations ahead of
 *  aliases. Within one definition the non-alias view wins — otherwise the barrel that navto
 *  happened to visit first becomes the resolved position, which is the alias-pinning bug itself.
 *  Candidates whose definition can't be resolved stay distinct — dropping them could hide a real
 *  ambiguity. */
export function distinctDeclarations(
  h: TsProjectHost,
  matches: readonly SymbolView[],
): AmbiguityCandidate[] {
  const byDefinition = new Map<string, AmbiguityCandidate>();
  for (const match of matches) {
    const abs = h.absOf(match.span.file);
    // sourceFileAcross, not the primary program: a candidate declared only in a sibling /
    // member program resolves to no primary SourceFile, and a positional fallback key would
    // leave every barrel in that program listed as its own "distinct declaration".
    const found = h.sourceFileAcross(abs);
    const offset =
      found === undefined ? undefined : offsetOfLoc(found.sf, match.span.line, match.span.col);
    // An alias whose module spec no program can resolve stays its own distinct candidate — we
    // cannot prove two unresolved aliases name one symbol, so we do not claim it.
    const def =
      offset === undefined ? undefined : definitionOf(h, match, abs, offset, found?.program);
    const key =
      def === undefined
        ? `${match.span.file}:${match.span.line}:${match.span.col}`
        : `${def.fileName}:${def.textSpan.start}`;
    const candidate: AmbiguityCandidate = {
      view: match,
      ...(def !== undefined ? withTarget(h, match, def) : {}),
    };
    const prev = byDefinition.get(key);
    // First per definition wins, EXCEPT that a real declaration displaces an alias for the same
    // definition — the declaration is what the agent means by the name.
    if (prev === undefined || (isAlias(prev.view) && !isAlias(match)))
      byDefinition.set(key, candidate);
  }
  return rank([...byDefinition.values()]);
}

/** Real declarations first, aliases after; original (navto) order kept within each group so the
 *  answer stays deterministic for a given program set. (The program SET itself can grow over a
 *  session — file-driven nearest-config loads — which is the separate cold==warm gap in t-009660.) */
function rank(candidates: readonly AmbiguityCandidate[]): AmbiguityCandidate[] {
  return [...candidates].sort((a, b) => Number(isAlias(a.view)) - Number(isAlias(b.view)));
}

function isAlias(view: SymbolView): boolean {
  return view.kind === ALIAS_KIND;
}

/** The definition behind ONE candidate, in the project's own terms — the collapse key's source.
 *
 *  The program that OWNS the file answers first (primary-first, via `sourceFileAcross`). But a
 *  loose-root monorepo's primary globs a member's files WITHOUT the member's `paths`, so an
 *  `import { X } from '@/…'` specifier resolves to nothing there and TS reports the specifier as its
 *  OWN definition. Every consumer's import binding then keys as a separate "distinct declaration",
 *  and a barrel-heavy name reads as N-way ambiguous while naming ONE symbol (t-000524). The member's
 *  own program resolves that exact spec, so an ALIAS that resolved to itself is re-asked across the
 *  other built programs containing the file. The collapse stays PROVEN by the project's own module
 *  resolution — never a second resolver of ours (§3.1).
 *
 *  The re-ask requires UNANIMITY, not a first hit: every consulted program is asked, and the
 *  definition is taken only when the ones that resolved it agree. Two configs can map one spec to
 *  DIFFERENT files (a `paths` override, src-vs-dist types); collapsing onto whichever program we
 *  happened to ask first would make the answer an artifact of our iteration order and could merge an
 *  alias into a declaration it does not name. On disagreement the candidate stays distinct — an
 *  honest ambiguity the agent resolves by pinning one. This is also why no ordering rule is needed:
 *  a unanimous answer is the same whatever order it is collected in (§16 cold == warm).
 *
 *  WHICH programs may answer — and the fact that SELECTING them must not build one — is
 *  `resolutionPrograms` (`program/resolution-programs.ts`): the built set only (never a file-driven
 *  `ensureProgramFor` load, so a mutation can see the same evidence and the verdict does not depend
 *  on query history), narrowed by the globbed file lists, and gated on the file's own nearest
 *  tsconfig being present so a foreign config that merely globs the file cannot become the authority.
 *
 *  COST (§1): the programs that OWN the file are built — typically one beside the primary, not the
 *  whole fan-out. Paid only when an unresolvable ALIAS is actually present, only on the bare-`{name}`
 *  resolve path, and only after the file's own program failed to resolve it. The per-candidate work
 *  is one `getDefinitionAtPosition` per consulted program; the materialization is once per session. */
function definitionOf(
  h: TsProjectHost,
  match: SymbolView,
  abs: string,
  offset: number,
  owner: TsProgram | undefined,
): ts.DefinitionInfo | undefined {
  // "Resolved to nothing": TS answers an unresolvable specifier with the specifier itself; a
  // missing answer is the same failure one step earlier. Both are re-askable.
  const unresolved = (d: ts.DefinitionInfo | undefined): boolean =>
    d === undefined || (d.fileName === abs && d.textSpan.start === offset);
  const own = owner === undefined ? undefined : definitionAt(owner.service, abs, offset);
  // A real declaration IS its own definition, so only an ALIAS pointing at itself is a failed
  // resolution worth re-asking — retrying a declaration would be pure cost for an identical answer.
  if (!isAlias(match) || !unresolved(own)) return own;
  let agreed: ts.DefinitionInfo | undefined;
  for (const program of h.resolutionPrograms(abs)) {
    if (program === owner || !holdsName(program, abs, offset, match.name)) continue;
    const retry = definitionAt(program.service, abs, offset);
    if (retry === undefined || unresolved(retry)) continue;
    if (agreed === undefined) agreed = retry;
    // Two programs resolving one spec to different declarations: we cannot say which the file
    // means, so we claim neither and the candidate stays distinct (§3.4).
    else if (!sameDefinition(agreed, retry)) return own;
  }
  return agreed ?? own;
}

/** Does `offset` still start our identifier in THIS program's text? The offset was computed against
 *  the OWNING program's SourceFile, and a planning overlay / trial edit lives on the primary alone
 *  (§5-L2) — so a sibling reading disk can hold different text at the same offset, where the position
 *  would denote an unrelated node and its "definition" an unrelated symbol. Comparing the identifier
 *  is what makes the two positions the same position; a mismatch means the programs disagree about
 *  the file, and the candidate keeps its own key rather than collapsing on a coincidence. */
function holdsName(program: TsProgram, abs: string, offset: number, name: string): boolean {
  const text = program.getProgram()?.getSourceFile(abs)?.text;
  return text !== undefined && text.slice(offset, offset + name.length) === name;
}

function sameDefinition(a: ts.DefinitionInfo, b: ts.DefinitionInfo): boolean {
  return a.fileName === b.fileName && a.textSpan.start === b.textSpan.start;
}

function definitionAt(
  service: ts.LanguageService,
  abs: string,
  offset: number,
): ts.DefinitionInfo | undefined {
  try {
    // `?.[0]`: within one program the first definition is the one navto ranked; ACROSS programs it
    // is a weaker assumption (a merged interface+impl can order its declarations by root-file order),
    // so an ordering difference shows up as disagreement — an extra candidate, never a wrong collapse.
    return service.getDefinitionAtPosition(abs, offset)?.[0];
  } catch (thrown) {
    // A DEADLINE cancellation must not be swallowed: the LS throws `OperationCanceledException` when
    // the budget is spent, and reading that as "no definition" would key every remaining candidate
    // positionally and answer `'X' is ambiguous — shown N of N distinct declaration sites` — a
    // fabricated count over a search that never finished (§3.4). Let it out so the op reports an
    // honest `timeout` (§19; translated by `cancellation.ts`, whose `instanceof` idiom this mirrors).
    if (thrown instanceof ts.OperationCanceledException) throw thrown;
    // Any OTHER LS throw only costs us a collapse, never correctness: the candidate stays distinct
    // under its positional key (§3.6 — degrade, don't crash).
    return undefined;
  }
}

/** The declaration an alias stands for, as a `file:line:col` the agent can read. Omitted when the
 *  definition IS the candidate itself (a real declaration resolves to its own name token). */
function withTarget(
  h: TsProjectHost,
  match: SymbolView,
  def: ts.DefinitionInfo,
): Pick<AmbiguityCandidate, 'target'> {
  const rel = h.relOf(def.fileName);
  const found = h.sourceFileAcross(def.fileName);
  if (found === undefined) return {};
  const { line, character } = found.sf.getLineAndCharacterOfPosition(def.textSpan.start);
  const loc = { file: rel, line: line + 1, col: character + 1 };
  if (loc.file === match.span.file && loc.line === match.span.line) return {};
  return { target: loc };
}

/** The honest ambiguity message: a ranked, capped candidate list of copy-pasteable SymbolIds.
 *  `budgetHit` says the candidate search itself was truncated (either cap — our view budget or the
 *  LS's own page), so the count is a lower bound. It is disclosed SEPARATELY from the display cap
 *  (`N more not shown`), which is a rendering choice with a different remedy: the display cap is
 *  recoverable by enumerating, this one only by narrowing the target. */
export function ambiguityMessage(
  name: string,
  candidates: readonly AmbiguityCandidate[],
  budgetHit: boolean,
): string {
  const shown = candidates.slice(0, SHOWN_CANDIDATES);
  const hidden = candidates.length - shown.length;
  const total = `${budgetHit ? '≥' : ''}${candidates.length}`;
  // Verdict-first (§12), and the honesty channels + the remedy come BEFORE the bulk: the candidate
  // list is up to 8 long SymbolIds, and an agent reading a failure through `head` — or an output cut
  // at a seam — must still get the count, the two truncation disclosures and what to do next.
  // {shown, total} is stated always: a bare count that happens to equal the shown list is exactly
  // how a capped answer reads as a complete one (§3.4).
  const head = `'${name}' is ambiguous — shown ${shown.length} of ${total} distinct declaration sites`;
  // §12 wants "N more + HOW TO NARROW" — and the hidden candidates' files are exactly what a
  // `name+file` steer would require the agent to already know, so the enumerating ops are named.
  const more =
    hidden > 0
      ? ` !! ${hidden} more not shown — enumerate them with search_symbol {query:'${name}'} or symbols_overview {query:'${name}', duplicatesOnly:true}`
      : '';
  const floor = budgetHit
    ? ' !! the candidate search was truncated (the LS page cap and/or this budget) — the total is a LOWER BOUND, more declarations may exist'
    : '';
  const steer =
    ' — pass one of the SymbolIds below (or file:line:col); name+file resolves a declaration in one file directly';
  const list = shown.map(renderCandidate).join(', ');
  return `${head}${more}${floor}${steer} · candidates (real declarations first): ${list}`;
}

function renderCandidate(c: AmbiguityCandidate): string {
  const target =
    c.target !== undefined ? ` → ${c.target.file}:${c.target.line}:${c.target.col}` : '';
  return `${c.view.id} (${c.view.kind}${target})`;
}
