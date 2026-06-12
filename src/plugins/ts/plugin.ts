// The `ts` plugin — owner of the TypeScript domain (§5-L2): the long-lived LS (lazy
// warm), target resolution (SymbolId / file:line:col / name), proof-carrying rebind
// (§6), and the cross-tier `cssModuleUsages` other plugins consume. Public API only;
// internals (ls-host, queries) stay behind this module.

import type { Plugin, PluginRegistry, FreshnessFingerprint } from '../../core/plugin.ts';
import type { RepoRelPath } from '../../core/brands.ts';
import type { HandleRebind, SymbolId } from '../../core/ids.ts';
import { decodeSymbolId } from '../../common/ids/codec.ts';
import { createTsProjectHost, type TsProjectHost } from './ls-host.ts';
import { offsetOfLoc } from './spans.ts';
import {
  expandTypeAt,
  findDefinitions,
  findUsages,
  searchSymbols,
  type SearchFilter,
  type SearchView,
  type SymbolView,
  type TypeView,
  type UsageOptions,
  type UsagesView,
} from './queries.ts';
import { scanCssModuleUsages, type CssModuleUsages } from './css-modules.ts';
import { findImporters, type ImportersView } from './importers.ts';

export type TsTargetInput = {
  /** A `ts:`-prefixed SymbolId from a previous answer. */
  symbol?: string | undefined;
  /** Or an explicit position. */
  file?: string | undefined;
  line?: number | undefined;
  col?: number | undefined;
  /** Or a name to resolve via workspace symbol search (must match exactly one). */
  name?: string | undefined;
};

export type ResolvedTarget =
  | { ok: true; abs: string; offset: number; rebind?: HandleRebind }
  | { ok: false; message: string; rebind?: HandleRebind };

export interface TsPluginApi extends Plugin {
  searchSymbol(query: string, limit: number, filter?: SearchFilter): SearchView;
  findDefinition(target: TsTargetInput): { views: SymbolView[]; rebind?: HandleRebind } | string;
  findUsages(
    target: TsTargetInput,
    options: UsageOptions,
  ): { view: UsagesView; rebind?: HandleRebind } | string;
  expandType(target: TsTargetInput): { view: TypeView; rebind?: HandleRebind } | string;
  /** Cross-tier API for the scss plugin (§5-L2). */
  cssModuleUsages(): CssModuleUsages;
  /** Module-graph: who imports / re-exports from a module (tsconfig-paths aware). */
  importersOf(module: string): ImportersView;
  /** Which TypeScript drives the LS — reported through status (§5-L1 note). */
  readonly tsVersion: string;
}

export function createTsPlugin(root: string, tsconfigOverride?: string): TsPluginApi {
  let host: TsProjectHost | undefined;
  let pendingBeforeWarm: RepoRelPath[] = [];

  const warm = (): TsProjectHost => {
    if (host === undefined) {
      host = createTsProjectHost(root, tsconfigOverride);
      pendingBeforeWarm = [];
    }
    return host;
  };

  const resolve = (target: TsTargetInput): ResolvedTarget => {
    const h = warm();
    if (target.symbol !== undefined) return resolveSymbolId(h, target.symbol);
    if (target.file !== undefined && target.line !== undefined && target.col !== undefined) {
      const abs = h.absOf(target.file as RepoRelPath);
      const sourceFile = h.service.getProgram()?.getSourceFile(abs);
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
    if (target.name !== undefined) {
      const matches = searchSymbols(h, target.name, 10).matches.filter(
        (m) => m.name === target.name,
      );
      const first = matches[0];
      if (first === undefined) return { ok: false, message: `no symbol named '${target.name}'` };
      // Multiple navto entries are often ONE logical symbol seen twice — the
      // declaration plus an `export { X }` specifier (the shadcn-style module
      // pattern). Resolve each candidate to its definition; if they all land on one
      // declaration, there is no ambiguity to report.
      const distinct = matches.length === 1 ? [first] : dedupeByDefinition(h, matches);
      const sole = distinct[0];
      if (distinct.length > 1 || sole === undefined) {
        return {
          ok: false,
          message: `'${target.name}' is ambiguous (${distinct.length} distinct declarations: ${distinct
            .map((m) => `${m.span.file}:${m.span.line}`)
            .join(', ')}) — pass file:line:col or a SymbolId`,
        };
      }
      const abs = warm().absOf(sole.span.file);
      const sourceFile = warm().service.getProgram()?.getSourceFile(abs);
      const offset =
        sourceFile === undefined
          ? undefined
          : offsetOfLoc(sourceFile, sole.span.line, sole.span.col);
      if (offset === undefined) return { ok: false, message: `cannot locate '${target.name}'` };
      return { ok: true, abs, offset };
    }
    return { ok: false, message: 'target needs symbol, file+line+col, or name' };
  };

  return {
    id: 'ts',
    version: '0.1.0',
    deps: [],
    tsVersion: tsVersionString(),

    init(_deps: PluginRegistry) {
      // Fully lazy: the LS warms on the first query (§9).
      return Promise.resolve();
    },
    dispose() {
      host?.dispose();
      host = undefined;
      return Promise.resolve();
    },
    freshness(): FreshnessFingerprint {
      return host === undefined ? 'cold' : `v${host.projectVersion()}`;
    },
    reindex(changed) {
      if (host === undefined) {
        // Not warm yet — nothing stale: the host reads the current tree when built.
        pendingBeforeWarm = [];
        return Promise.resolve();
      }
      host.reindex(changed);
      return Promise.resolve();
    },
    pending() {
      return pendingBeforeWarm;
    },

    searchSymbol: (query, limit, filter) => searchSymbols(warm(), query, limit, filter),

    findDefinition(target) {
      const resolved = resolve(target);
      if (!resolved.ok) return resolved.message;
      const views = findDefinitions(warm(), resolved.abs, resolved.offset) ?? [];
      return { views, ...(resolved.rebind !== undefined ? { rebind: resolved.rebind } : {}) };
    },

    findUsages(target, options) {
      const resolved = resolve(target);
      if (!resolved.ok) return resolved.message;
      const view = findUsages(warm(), resolved.abs, resolved.offset, options);
      if (view === undefined) return 'no symbol at the resolved position';
      return { view, ...(resolved.rebind !== undefined ? { rebind: resolved.rebind } : {}) };
    },

    expandType(target) {
      const resolved = resolve(target);
      if (!resolved.ok) return resolved.message;
      const view = expandTypeAt(warm(), resolved.abs, resolved.offset);
      if (view === undefined) return 'no type information at the resolved position';
      return { view, ...(resolved.rebind !== undefined ? { rebind: resolved.rebind } : {}) };
    },

    cssModuleUsages: () => scanCssModuleUsages(warm()),

    importersOf: (module) => findImporters(warm(), module),
  };

  function resolveSymbolId(h: TsProjectHost, id: string): ResolvedTarget {
    const decoded = decodeSymbolId(id);
    if (decoded === undefined || decoded.plugin !== 'ts') {
      return { ok: false, message: `not a ts SymbolId: '${id}'` };
    }
    const m = decoded.payload.match(/^(.+)@(.+):(\d+):(\d+)$/);
    if (m === null) return { ok: false, message: `malformed ts SymbolId payload: '${id}'` };
    const [, name, rel, lineStr, colStr] = m;
    if (name === undefined || rel === undefined) {
      return { ok: false, message: `malformed ts SymbolId payload: '${id}'` };
    }
    const abs = h.absOf(rel as RepoRelPath);
    const sourceFile = h.service.getProgram()?.getSourceFile(abs);
    const line = Number(lineStr);
    const col = Number(colStr);

    if (sourceFile !== undefined) {
      const offset = offsetOfLoc(sourceFile, line, col);
      // Still the same symbol at the recorded position? Then the handle holds.
      if (offset !== undefined && sourceFile.text.startsWith(name, offset)) {
        return { ok: true, abs, offset };
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
    const candFile = h.service.getProgram()?.getSourceFile(candAbs);
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
    // Prefer the candidate that IS the definition site (matches its own key) over a
    // re-mention; otherwise first wins.
    if (!byDefinition.has(key)) byDefinition.set(key, match);
  }
  return [...byDefinition.values()];
}

function tsVersionString(): string {
  // Bundled TS for now (project-own TS resolution is roadmap §19); stated via status.
  return `bundled-ts`;
}
