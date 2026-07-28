// The candidate list a bare `{name}` returns when it resolves to more than one declaration.
// Its whole job is that the agent's NEXT call hits the symbol it meant: an ambiguity report that
// enumerates re-export specifiers while the real declaration is missing steers the agent to pin an
// ALIAS (§3.4 — a target that is not shown cannot be chosen). So three rules live here:
//
//   1. Collapse by DEFINITION — the barrel chain (`export { X } from './x'`) is one symbol seen N
//      times; within one definition a real declaration always beats the alias that points at it.
//   2. Rank declaration-first — an alias is never the default pick.
//   3. Count honestly — the enumerated set is capped for readability, and both the display cap and
//      the search budget are disclosed (`… N more`, `≥N`), never a silently short list.
//
// Each entry is printed as its canonical SymbolId (which CONTAINS file:line:col, so nothing is lost)
// so the agent copies one verbatim into `symbolId`; an alias also carries the declaration it
// resolves to, so picking one is an informed choice rather than a guess.

import type ts from 'typescript';
import type { RepoRelPath } from '../../core/brands.ts';
import type { TsProjectHost } from './ls-host.ts';
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
    // An alias whose module spec does NOT resolve in the answering program (a loose-root monorepo
    // where the file's own `paths` live in a member config) reports ITSELF as its definition — it
    // then stays its own distinct candidate rather than collapsing into the declaration. Honest:
    // we cannot prove two unresolved aliases name one symbol, so we do not claim it (t-000524).
    const def =
      found === undefined || offset === undefined
        ? undefined
        : definitionAt(found.program.service, abs, offset);
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

function definitionAt(
  service: ts.LanguageService,
  abs: string,
  offset: number,
): ts.DefinitionInfo | undefined {
  try {
    return service.getDefinitionAtPosition(abs, offset)?.[0];
  } catch {
    // An LS throw here only costs us a collapse, never correctness: the candidate stays distinct
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
