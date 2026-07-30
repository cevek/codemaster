// The §6 handle path: decode a `ts:` SymbolId, verify it still names its symbol at the recorded
// position, and otherwise REBIND it — proof-carrying, never silently. Split out of
// `resolve-target.ts` (line cap): that file dispatches the three addressing forms, this one owns
// the handle contract (same-position check → same-file re-read → workspace re-location → `gone`).

import type { HandleRebind, SymbolId } from '../../core/ids.ts';
import type { TsProjectHost } from './ls-host.ts';
import { offsetOfLoc, spanFromRange } from './spans.ts';
import { searchSymbols } from './search.ts';
import { mintSymbolId, parseTsSymbolId } from './symbol-id.ts';
import { topLevelDeclarationsNamed } from './declarations-on-line.ts';
import { NAME_CANDIDATE_LIMIT, type ResolvedTarget } from './resolve-contract.ts';

/** Resolve a held `ts:` SymbolId to a position (§6). */
export function resolveSymbolId(h: TsProjectHost, id: string, root: string): ResolvedTarget {
  // ONE parser for the format (symbol-id.ts, the inverse of `mintSymbolId`) — the syntactic handle
  // path reads the same one, so the two can never disagree on what a handle is.
  const decoded = parseTsSymbolId(id);
  if (!decoded.ok) return { ok: false, message: decoded.message };
  const { name, rel, line, col, rootTag: tag } = decoded.parsed;
  // Cross-root guard (§6 / spec-stresstest §4b): a SymbolId carries the workspace it was minted in.
  // If it was minted in a DIFFERENT root than the one resolving it (an `amiro` id passed with
  // root:'../cf2'), do NOT name-rebind it onto a same-named symbol in this repo — that binds the
  // handle to a different symbol entirely. Report `gone` and tell the agent to re-search here.
  if (tag !== undefined && tag !== h.rootTag) {
    return {
      ok: false,
      message: `SymbolId '${id}' was minted in a different workspace root — re-search the symbol by name in this root (SymbolIds do not cross roots)`,
      rebind: {
        status: 'gone',
        from: id as SymbolId,
        reason: 'handle belongs to a different workspace root — re-search by name in the new root',
      },
    };
  }
  const abs = h.absOf(rel);
  const sourceFile = h.sourceFileAcross(abs)?.sf;

  if (sourceFile !== undefined) {
    const offset = offsetOfLoc(sourceFile, line, col);
    // Still the same symbol at the recorded position? `startsWith` alone is a prefix test —
    // a LONGER identifier sharing the prefix (`foobar` where `foo` was) would pass it and
    // silently bind the handle to the wrong symbol with no rebind/note. Require a word
    // boundary after the name so only the exact identifier holds the handle (§6).
    if (offset !== undefined && sourceFile.text.startsWith(name, offset)) {
      const next = sourceFile.text[offset + name.length];
      if (next === undefined || !/[A-Za-z0-9_$]/.test(next)) {
        return { ok: true, abs, offset };
      }
    }
  }

  // Rebind (§6), step 1: the handle's OWN file, read directly off its AST. The handle already names
  // the file, so this needs no workspace search and cannot be defeated by a ranked page — which the
  // search-first order could be: under a fuzzy flood the held name never reached the page and a
  // present symbol read as unrelocatable. SEVERAL top-level matches of one name in one file are a
  // MERGED symbol (an overload set, `interface` + `namespace`, `function` + `namespace`) — TS
  // rejects any non-mergeable duplicate — so the first is that symbol's declaration, not a rival
  // candidate. Only a name that appears nowhere top-level here falls through to the search below
  // (a handle on a nested declaration — a class method — still does: t-726108).
  if (sourceFile !== undefined) {
    const own = topLevelDeclarationsNamed(sourceFile, name);
    const sole = own[0];
    if (sole !== undefined) {
      const span = spanFromRange(sourceFile, rel, sole.offset, sole.offset + name.length);
      return {
        ok: true,
        abs,
        offset: sole.offset,
        rebind: {
          status: 'rebound',
          from: id as SymbolId,
          to: {
            id: mintSymbolId(name, rel, span.line, span.col, h.rootTag) as SymbolId,
            name,
            kind: sole.kind,
            loc: { file: rel, line: span.line, col: span.col },
          },
          proof: span,
          confidence: 'partial',
          note: `'${name}' (${sole.kind}${own.length > 1 ? `, ${own.length} merged declarations` : ''}) is now at ${rel}:${span.line}:${span.col} — same file, moved position; structural continuity not proven`,
        },
      };
    }
  }

  // Rebind (§6), step 2: workspace-wide. Same exact-name-inside
  // the-search discipline as `resolveByName`: a post-filtered fuzzy page can come back with the
  // held name crowded out, and the handle would then read `gone` ("no symbol of this name/kind
  // remains") when it is merely outranked — a §6 misreport. Declarations before aliases, so a
  // rebind lands on the declaration rather than a barrel that re-exports it.
  const relocated = searchSymbols(h, name, NAME_CANDIDATE_LIMIT, root, undefined, false, {
    nameExact: name,
    preferDeclarations: true,
  });
  const candidates = relocated.matches;
  const sameFile = candidates.find((c) => c.span.file === rel);
  const candidate = sameFile ?? candidates[0];
  if (candidate === undefined) {
    // `gone` is a CLAIM about the workspace ("no symbol of this name/kind remains"), so it may only
    // be made over a search that actually completed. Under the LS's own sliced page an empty result
    // proves nothing — reporting `gone` there would be §6's forbidden reading of "merely outranked"
    // as "removed". Fail honestly with no rebind claim instead.
    if (relocated.searchTruncated) {
      return {
        ok: false,
        message: `could not re-locate '${name}' (handle ${id}) — the workspace symbol search hit the LS's own result cap, so this is NOT evidence the symbol is gone; re-address it by name+file or file:line:col`,
      };
    }
    return {
      ok: false,
      message: `symbol '${name}' no longer found (handle ${id})`,
      rebind: {
        status: 'gone',
        from: id as SymbolId,
        reason: 'no symbol of this name/kind remains in the workspace',
      },
    };
  }
  const candAbs = h.absOf(candidate.span.file);
  const candFile = h.sourceFileAcross(candAbs)?.sf; // candidate may be sibling-declared (cross-program search)
  const candOffset =
    candFile === undefined
      ? undefined
      : offsetOfLoc(candFile, candidate.span.line, candidate.span.col);
  if (candOffset === undefined) {
    return { ok: false, message: `cannot re-locate '${name}' after file change` };
  }
  const rebind: HandleRebind = {
    status: 'rebound',
    from: id as SymbolId,
    to: {
      id: candidate.id as SymbolId,
      name: candidate.name,
      kind: candidate.kind,
      loc: { file: candidate.span.file, line: candidate.span.line, col: candidate.span.col },
    },
    proof: candidate.span,
    confidence: 'partial',
    note: `a ${candidate.kind} named '${name}' is here now; structural continuity not proven`,
  };
  return {
    ok: true,
    abs: candAbs,
    offset: candOffset,
    rebind,
    // A rebind that landed in the handle's OWN file is anchored by the handle, not chosen out of a
    // ranked page — a slice elsewhere cannot have hidden a better answer, so it carries no floor
    // (flagging it made a mutation refuse a precisely-addressed target). Only the workspace
    // FALLBACK pick — one of possibly-cut candidates in another file — inherits the truncation.
    ...(relocated.searchTruncated && sameFile === undefined
      ? { searchTruncated: true as const }
      : {}),
  };
}
