// Resolve a `ts:` SymbolId to a concrete position, with a proof-carrying rebind (§6) when
// the handle's file has changed. Split out of `plugin.ts` (300-line cap); pure over the host.

import { decodeSymbolId } from '../../common/ids/codec.ts';
import type { RepoRelPath } from '../../core/brands.ts';
import type { HandleRebind, SymbolId } from '../../core/ids.ts';
import type { TsProjectHost } from './ls-host.ts';
import { offsetOfLoc } from './spans.ts';
import { searchSymbols } from './search.ts';
import type { SymbolView } from './query-types.ts';

export type ResolvedTarget =
  | { ok: true; abs: string; offset: number; rebind?: HandleRebind }
  | { ok: false; message: string; rebind?: HandleRebind };

/** The three ways an agent addresses a symbol (§6 targets): a held `ts:` SymbolId, an
 *  explicit `file+line+col`, or an unambiguous `name`. */
export type TsTargetInput = {
  /** A `ts:`-prefixed SymbolId from a previous answer (NOT a bare name — that is `name`).
   *  The natural `target` spelling is collapsed to `symbolId` by the liberal intake layer
   *  (§7 Postel) before any args reach the resolver, so only `symbolId` exists here. */
  symbolId?: string | undefined;
  /** Or an explicit position. */
  file?: string | undefined;
  line?: number | undefined;
  col?: number | undefined;
  /** Or a name to resolve via workspace symbol search (must match exactly one). */
  name?: string | undefined;
};

/** Resolve any `TsTargetInput` to a concrete `{abs, offset}` (with a §6 rebind when a held
 *  SymbolId's file moved). Pure over the host — the shared entry every symbol-addressed read
 *  method funnels through, so SymbolId / file:line:col / name dispatch lives in one place. */
export function resolveTarget(h: TsProjectHost, target: TsTargetInput): ResolvedTarget {
  // `target`/`symbol` aliases are collapsed to `symbolId`/`name` by the intake layer (§7)
  // before any args reach here, so the resolver sees only the canonical fields.
  if (target.symbolId !== undefined) return resolveSymbolId(h, target.symbolId);
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
  if (target.name !== undefined) return resolveByName(h, target.name);
  return { ok: false, message: 'target needs symbolId, file+line+col, or name' };
}

/** Name → position, via the LS workspace-symbol provider. Multiple navto entries are often
 *  ONE logical symbol seen twice (a declaration + its `export { X }` specifier — the shadcn
 *  module pattern), so candidates are deduped by definition; a genuine ambiguity returns the
 *  candidate list with file:line:col (+ kind) so the agent can pick one. */
function resolveByName(h: TsProjectHost, name: string): ResolvedTarget {
  const matches = searchSymbols(h, name, 10).matches.filter((m) => m.name === name);
  const first = matches[0];
  if (first === undefined) return { ok: false, message: `no symbol named '${name}'` };
  const distinct = matches.length === 1 ? [first] : dedupeByDefinition(h, matches);
  const sole = distinct[0];
  if (distinct.length > 1 || sole === undefined) {
    // Carry file:line:COL (+ kind) — two distinct declarations can share a line (a `const` and
    // its named function expression both at col 41); without the column they render as a
    // spurious duplicate. The col also makes each entry a copy-paste file:line:col target.
    return {
      ok: false,
      message: `'${name}' is ambiguous (${distinct.length} distinct declarations: ${distinct
        .map((m) => `${m.span.file}:${m.span.line}:${m.span.col} (${m.kind})`)
        .join(', ')}) — pass file:line:col or a SymbolId`,
    };
  }
  const abs = h.absOf(sole.span.file);
  // sourceFileAcross, not the primary: searchSymbols now spans programs, so a matched symbol may
  // live in a sibling-only file (a test helper) the primary program does not contain.
  const sourceFile = h.sourceFileAcross(abs)?.sf;
  const offset =
    sourceFile === undefined ? undefined : offsetOfLoc(sourceFile, sole.span.line, sole.span.col);
  if (offset === undefined) return { ok: false, message: `cannot locate '${name}'` };
  return { ok: true, abs, offset };
}

/** One resolved declaration in `mergeDeclarations` mode: a concrete `{abs, offset}` plus the
 *  `SymbolView` that identifies it (the merge legend the per-site `decls` indices point into). */
export type ResolvedDeclaration = { abs: string; offset: number; view: SymbolView };

/** Resolve a name to ALL its distinct declarations (the interface-decl + host-decl + impl triplet
 *  pattern), deduped by definition — the multi-declaration analogue of `resolveByName`, which
 *  fails on that ambiguity. Each entry carries the SymbolView (id/name/kind/span) so the caller can
 *  list what it merged (`UsagesView.mergedDeclarations`). Returns a message when nothing matches or
 *  a declaration can't be located. */
export function resolveAllByName(h: TsProjectHost, name: string): ResolvedDeclaration[] | string {
  // The navto cap is comfortably above any realistic count of DISTINCT declarations of one exact
  // name (the interface + host + impl pattern is 3; a same-named-everywhere method a handful) — far
  // more than 50 would be a degenerate name, not a merge an agent reasons over. Same silent-bound
  // class as `resolveByName`'s navto cap; raising it never un-truncates a smaller real answer.
  const matches = searchSymbols(h, name, 50).matches.filter((m) => m.name === name);
  if (matches.length === 0) return `no symbol named '${name}'`;
  const distinct = matches.length === 1 ? matches : dedupeByDefinition(h, matches);
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
  return out;
}

function resolveSymbolId(h: TsProjectHost, id: string): ResolvedTarget {
  const decoded = decodeSymbolId(id);
  // A real SymbolId's payload always carries the `@file` separator (`plugin:Name@rel:line:col`).
  // A value with no usable prefix (a bare name) — OR one whose first `:` is incidental and leaves
  // an `@`-less payload (a `file:line:col` position pasted into the field) — is not a SymbolId at
  // all. Both are the misplaced-input friction this op hardened against, so point the agent at the
  // RIGHT field (`name` / `file+line+col`), not at an opaque "not a SymbolId" or a phantom plugin.
  const looksLikeSymbolId = decoded !== undefined && decoded.payload.includes('@');
  if (decoded === undefined || (!looksLikeSymbolId && decoded.plugin !== 'ts')) {
    return {
      ok: false,
      message: `'${id}' is not a SymbolId (those look like 'ts:Name@file:line:col') — to search by name pass it under 'name', or to address by position pass file+line+col`,
    };
  }
  if (decoded.plugin !== 'ts') {
    return {
      ok: false,
      message: `SymbolId '${id}' belongs to plugin '${decoded.plugin}', not 'ts' — this op resolves ts symbols`,
    };
  }
  const m = decoded.payload.match(/^(.+)@(.+):(\d+):(\d+)(?:~([0-9a-f]+))?$/);
  if (m === null) return { ok: false, message: `malformed ts SymbolId payload: '${id}'` };
  const [, name, rel, lineStr, colStr, tag] = m;
  if (name === undefined || rel === undefined) {
    return { ok: false, message: `malformed ts SymbolId payload: '${id}'` };
  }
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
  const abs = h.absOf(rel as RepoRelPath);
  const sourceFile = h.sourceFileAcross(abs)?.sf;
  const line = Number(lineStr);
  const col = Number(colStr);

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

  // Rebind (§6): re-locate by name — same file first, then workspace-wide.
  const candidates = searchSymbols(h, name, 20).matches.filter((c) => c.name === name);
  const sameFile = candidates.find((c) => c.span.file === rel);
  const candidate = sameFile ?? candidates[0];
  if (candidate === undefined) {
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
  return { ok: true, abs: candAbs, offset: candOffset, rebind };
}

/** Collapse same-named navto candidates that resolve to one declaration (decl +
 *  `export { X }` re-mention). Candidates whose definition can't be resolved stay —
 *  dropping them could hide a real ambiguity. */
function dedupeByDefinition(h: TsProjectHost, matches: readonly SymbolView[]): SymbolView[] {
  const byDefinition = new Map<string, SymbolView>();
  for (const match of matches) {
    const abs = h.absOf(match.span.file);
    const sourceFile = h.service.getProgram()?.getSourceFile(abs);
    const offset =
      sourceFile === undefined
        ? undefined
        : offsetOfLoc(sourceFile, match.span.line, match.span.col);
    let key = `${match.span.file}:${match.span.line}:${match.span.col}`;
    if (offset !== undefined) {
      const def = h.service.getDefinitionAtPosition(abs, offset)?.[0];
      if (def !== undefined) key = `${def.fileName}:${def.textSpan.start}`;
    }
    // First candidate per definition-key wins (navto order); a later re-mention of the same
    // declaration is collapsed away.
    if (!byDefinition.has(key)) byDefinition.set(key, match);
  }
  return [...byDefinition.values()];
}
