// Resolve a `ts:` SymbolId to a concrete position, with a proof-carrying rebind (§6) when
// the handle's file has changed. Split out of `plugin.ts` (300-line cap); pure over the host.

import type { RepoRelPath } from '../../core/brands.ts';
import type { TsProjectHost } from './ls-host.ts';
import { offsetOfLoc } from './spans.ts';
import { searchSymbols } from './search.ts';
import { declarationsOnLine, topLevelDeclarationsNamed } from './declarations-on-line.ts';
import { ambiguityMessage, distinctDeclarations } from './ambiguity.ts';
import { resolveSymbolId } from './rebind-symbol-id.ts';
import { NAME_CANDIDATE_LIMIT, type ResolvedTarget } from './resolve-contract.ts';

export type { ResolvedTarget };
import type { SymbolView } from './query-types.ts';

/** The three ways an agent addresses a symbol (§6 targets): a held `ts:` SymbolId, an
 *  explicit `file+line+col`, or an unambiguous `name`. */
export type TsTargetInput = {
  /** A `ts:`-prefixed SymbolId from a previous answer (NOT a bare name — that is `name`).
   *  The natural `target` spelling is collapsed to `symbolId` by the liberal intake layer
   *  (§7 Postel) before any args reach the resolver, so only `symbolId` exists here. */
  symbolId?: string | undefined;
  /** Or an explicit position. With `col` omitted, `file+line` resolves the declaration on that
   *  line (one → taken; several → an honest pick-list), never a guessed column. */
  file?: string | undefined;
  line?: number | undefined;
  col?: number | undefined;
  /** Or a name to resolve via workspace symbol search (must match exactly one). With `file` also
   *  given, the name is resolved to its top-level declaration IN that file (rank-independent),
   *  never the fuzzy workspace search. */
  name?: string | undefined;
};

/** Resolve any `TsTargetInput` to a concrete `{abs, offset}` (with a §6 rebind when a held
 *  SymbolId's file moved). Pure over the host — the shared entry every symbol-addressed read
 *  method funnels through, so SymbolId / file:line:col / name dispatch lives in one place. */
export function resolveTarget(
  h: TsProjectHost,
  target: TsTargetInput,
  root: string,
): ResolvedTarget {
  // `target`/`symbol` aliases are collapsed to `symbolId`/`name` by the intake layer (§7)
  // before any args reach here, so the resolver sees only the canonical fields.
  if (target.symbolId !== undefined) return resolveSymbolId(h, target.symbolId, root);
  if (target.file !== undefined && target.line !== undefined && target.col !== undefined) {
    const abs = h.absOf(target.file as RepoRelPath);
    // Across ALL loaded programs (spec Task G): a `test/**` file lives only in a sibling program,
    // so a primary-only lookup would falsely reject a position in it.
    const sourceFile = h.sourceFileAcross(abs)?.sf;
    if (sourceFile === undefined) {
      return { ok: false, message: `file not in the TS project: ${target.file}` };
    }
    const offset = offsetOfLoc(sourceFile, target.line, target.col);
    if (offset === undefined) {
      return {
        ok: false,
        message: `position ${target.line}:${target.col} is outside ${target.file}`,
      };
    }
    return { ok: true, abs, offset };
  }
  // `file+line` WITHOUT a column (a grep/editor `path:line` paste): resolve the declaration ON
  // that line instead of demanding the column — one decl → take it; several → an honest pick-list
  // (never a fabricated column, §3/§6). `name`, when also given, scopes the line to that name.
  if (target.file !== undefined && target.line !== undefined) {
    return resolveByLine(h, target.file, target.line, target.name);
  }
  // `name+file` (no line/col): resolve the named declaration IN that file directly, rank-independent
  // — never the workspace-wide `resolveByName`, whose navto search is fuzzy + case-insensitive and
  // can flood an exact-but-low-rank symbol past its cap (e.g. type `Span` behind 132 `span` props).
  if (target.file !== undefined && target.name !== undefined) {
    return resolveNameInFile(h, target.name, target.file);
  }
  if (target.name !== undefined) return resolveByName(h, target.name, root);
  return {
    ok: false,
    message: 'target needs symbolId, name, file+line (col optional), or name+file',
  };
}

/** `name+file` (no line/col) → position, via the top-level declaration of that name in that file
 *  (rank-independent, never navto). A single match resolves; >1 same-named top-level declaration
 *  returns the candidates with their positions; none fails honestly. */
function resolveNameInFile(h: TsProjectHost, name: string, file: string): ResolvedTarget {
  const abs = h.absOf(file as RepoRelPath);
  const sourceFile = h.sourceFileAcross(abs)?.sf;
  if (sourceFile === undefined) {
    return { ok: false, message: `file not in the TS project: ${file}` };
  }
  const decls = topLevelDeclarationsNamed(sourceFile, name);
  const sole = decls[0];
  if (sole === undefined) {
    return {
      ok: false,
      message: `no top-level declaration named '${name}' in ${file} — check the name/file, or pass file:line:col`,
    };
  }
  if (decls.length > 1) {
    return {
      ok: false,
      message: `${file} has ${decls.length} top-level declarations named '${name}' (${decls
        .map((d) => `${d.line}:${d.col} (${d.kind})`)
        .join(', ')}) — pass file:line:col to pick one`,
    };
  }
  return { ok: true, abs, offset: sole.offset };
}

/** `file+line` (col-less) → position, via the declaration(s) anchored on that line. A single
 *  declaration resolves; an ambiguous line returns the candidates with their columns so the agent
 *  passes `file:line:col`; an empty line fails honestly. `name`, when given, filters the line's
 *  declarations to that name (so `name+file+line` is line-scoped, not a workspace-wide name search). */
function resolveByLine(
  h: TsProjectHost,
  file: string,
  line: number,
  name: string | undefined,
): ResolvedTarget {
  const abs = h.absOf(file as RepoRelPath);
  // sourceFileAcross, not the primary: a `test/**` position lives only in a sibling program.
  const sourceFile = h.sourceFileAcross(abs)?.sf;
  if (sourceFile === undefined) {
    return { ok: false, message: `file not in the TS project: ${file}` };
  }
  const all = declarationsOnLine(sourceFile, line);
  const decls = name === undefined ? all : all.filter((d) => d.name === name);
  const sole = decls[0];
  if (sole === undefined) {
    const named = name !== undefined ? ` named '${name}'` : '';
    return {
      ok: false,
      message: `no declaration${named} on ${file}:${line} — pass file:line:col (the column) or a 'name'`,
    };
  }
  if (decls.length > 1) {
    return {
      ok: false,
      message: `${file}:${line} has ${decls.length} declarations (${decls
        .map((d) => `${d.name} at col ${d.col} (${d.kind})`)
        .join(', ')}) — pass file:line:col to pick one`,
    };
  }
  return { ok: true, abs, offset: sole.offset };
}

/** Name → position, via the LS workspace-symbol provider. Multiple navto entries are often
 *  ONE logical symbol seen twice (a declaration + its `export { X }` specifier — the shadcn
 *  module pattern), so candidates are deduped by definition and ranked declaration-first; a
 *  genuine ambiguity returns that list (§3.4 shown/total honest) so the agent can pick one. */
function resolveByName(h: TsProjectHost, name: string, root: string): ResolvedTarget {
  // `nameExact` filters INSIDE the search, so the budget buys exact-name declarations only: a
  // post-filter over a fuzzy-ranked page lets a barrel chain crowd the real declaration off the
  // end (it is then absent from the ambiguity list — unpickable, §3.4) and miscounts the rest.
  const found = searchSymbols(h, name, NAME_CANDIDATE_LIMIT, root, undefined, false, {
    nameExact: name,
    preferDeclarations: true,
  });
  const matches = found.matches;
  const first = matches[0];
  if (first === undefined) {
    // An empty page under a SLICED workspace search is "couldn't", not "doesn't exist": navto ranks
    // by matchKind + name with no case tie-break, so a flood of `span` can fill the page and hide
    // the type `Span` entirely. Claiming absence there is the §3.6 lie (a "not found" the agent
    // cannot distinguish from a real one).
    return {
      ok: false,
      message: found.searchTruncated
        ? `could not determine whether '${name}' exists — the workspace symbol search hit the LS's own result cap, so its page may not contain it; pass name+file (resolves in one file, rank-independent), file:line:col, or narrow with search_symbol {query:'${name}', pathInclude:[…]}`
        : `no symbol named '${name}'`,
    };
  }
  const distinct = matches.length === 1 ? [{ view: first }] : distinctDeclarations(h, matches);
  const sole = distinct[0]?.view;
  if (distinct.length > 1 || sole === undefined) {
    // Each candidate prints as its canonical SymbolId (which contains file:line:col — two
    // declarations can share a line, so the column stays part of the identity) plus, for an
    // alias, the declaration it resolves to. The count is a LOWER BOUND when either cap bit — our
    // own view budget, or the LS's page slice, which runs BEFORE `nameExact` and is invisible to a
    // `total === shown` comparison (§3.4).
    return {
      ok: false,
      message: ambiguityMessage(
        name,
        distinct,
        found.total > matches.length || found.searchTruncated,
      ),
    };
  }
  const abs = h.absOf(sole.span.file);
  // sourceFileAcross, not the primary: searchSymbols now spans programs, so a matched symbol may
  // live in a sibling-only file (a test helper) the primary program does not contain.
  const sourceFile = h.sourceFileAcross(abs)?.sf;
  const offset =
    sourceFile === undefined ? undefined : offsetOfLoc(sourceFile, sole.span.line, sole.span.col);
  if (offset === undefined) return { ok: false, message: `cannot locate '${name}'` };
  // A single surviving candidate under a SLICED page is not proof of uniqueness — the bare-name
  // contract ("must match exactly one") would otherwise be asserted over a set we never saw (§3.4).
  return {
    ok: true,
    abs,
    offset,
    ...(found.searchTruncated ? { searchTruncated: true as const } : {}),
  };
}

/** One resolved declaration in `mergeDeclarations` mode: a concrete `{abs, offset}` plus the
 *  `SymbolView` that identifies it (the merge legend the per-site `decls` indices point into). */
export type ResolvedDeclaration = { abs: string; offset: number; view: SymbolView };

/** Resolve a name to ALL its distinct declarations (the interface-decl + host-decl + impl triplet
 *  pattern), deduped by definition — the multi-declaration analogue of `resolveByName`, which
 *  fails on that ambiguity. Each entry carries the SymbolView (id/name/kind/span) so the caller can
 *  list what it merged (`UsagesView.mergedDeclarations`). Returns a message when nothing matches or
 *  a declaration can't be located. */
export function resolveAllByName(
  h: TsProjectHost,
  name: string,
  root: string,
): { decls: ResolvedDeclaration[]; searchTruncated: boolean } | string {
  // The navto cap is comfortably above any realistic count of DISTINCT declarations of one exact
  // name (the interface + host + impl pattern is 3; a same-named-everywhere method a handful) — far
  // more than 50 would be a degenerate name, not a merge an agent reasons over. `nameExact` keeps
  // that budget spent on the asked-for name (a fuzzy page would crowd out real declarations).
  const found = searchSymbols(h, name, NAME_CANDIDATE_LIMIT, root, undefined, false, {
    nameExact: name,
    preferDeclarations: true,
  });
  const matches = found.matches;
  if (matches.length === 0) {
    return found.searchTruncated
      ? `could not determine whether '${name}' exists — the workspace symbol search hit the LS's own result cap; pass name+file or file:line:col`
      : `no symbol named '${name}'`;
  }
  const distinct = (
    matches.length === 1 ? [{ view: matches[0] }] : distinctDeclarations(h, matches)
  )
    .map((c) => c.view)
    .filter((v): v is SymbolView => v !== undefined);
  const out: ResolvedDeclaration[] = [];
  for (const m of distinct) {
    const abs = h.absOf(m.span.file);
    const sourceFile = h.sourceFileAcross(abs)?.sf;
    const offset =
      sourceFile === undefined ? undefined : offsetOfLoc(sourceFile, m.span.line, m.span.col);
    if (offset === undefined) continue; // a declaration we can't locate is dropped, never guessed
    out.push({ abs, offset, view: m });
  }
  if (out.length === 0) return `cannot locate any declaration of '${name}'`;
  // `mergeDeclarations` promises the union over ALL same-named declarations; under a sliced page it
  // can only union the ones the page held, so the caller must say so rather than imply totality.
  // BOTH caps matter here, unlike the single-resolution path: a merge unions the declarations it
  // was handed, so our own view cap (`total > matches`) hides same-named declarations just as the
  // LS page does. (On the single path our cap truncates BEFORE `distinctDeclarations` collapses a
  // barrel chain into one declaration, so it routinely bites on a COMPLETE answer — flagging it
  // there would be a false incompleteness.)
  return {
    decls: out,
    searchTruncated: found.searchTruncated || found.total > matches.length,
  };
}
