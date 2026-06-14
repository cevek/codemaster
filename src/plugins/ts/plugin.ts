// The `ts` plugin — owner of the TypeScript domain (§5-L2): the long-lived LS (lazy
// warm), target resolution (SymbolId / file:line:col / name), proof-carrying rebind
// (§6), and the cross-tier `cssModuleUsages` other plugins consume. Public API only;
// internals (ls-host, queries) stay behind this module.

import * as path from 'node:path';
import type { Plugin, PluginRegistry, FreshnessFingerprint } from '../../core/plugin.ts';
import type { RepoRelPath } from '../../core/brands.ts';
import type { HandleRebind } from '../../core/ids.ts';
import { createTsProjectHost, type TsProjectHost } from './ls-host.ts';
import { offsetOfLoc } from './spans.ts';
import { findDefinitions } from './definitions.ts';
import { findUsages, referenceSpans } from './usages.ts';
import { expandTypeAt } from './type-expand.ts';
import type { Span } from '../../core/span.ts';
import type {
  ExpandOptions,
  SymbolView,
  TypeView,
  UnresolvedTarget,
  UsageOptions,
  UsagesView,
} from './query-types.ts';
import { searchSymbols, type SearchFilter, type SearchView } from './search.ts';
import { scanCssModuleUsages, type CssModuleUsages } from './css-modules.ts';
import { scanLiteralCalls, type LiteralCall } from './literal-calls.ts';
import { findImporters, type ImportersView } from './importers.ts';
import { computeRename, type RenameChange } from './refactor/rename/rename-sites.ts';
import { collectDiagnostics, type TsDiagnostic } from './diagnostics.ts';
import { planMove } from './refactor/imports/plan-move.ts';
import { planExtractTo } from './refactor/extract/move-to-file.ts';
import { rewriteExtractedCss, type ImportRewrite } from './refactor/extract/css-usage.ts';
import { planChangeSignature, type SignatureChange } from './refactor/change-signature/plan.ts';
import { loadTreeFromGit } from './refactor/tree/build.ts';
import { isOk } from '../../common/result/narrow.ts';
import { resolveSymbolId, dedupeByDefinition, type ResolvedTarget } from './resolve-target.ts';
import type { RefactorPlan } from './refactor/plan.ts';

// Re-export the shapes ops consume so they go through the plugin's public surface rather
// than reaching into internal query/refactor modules (§5-L3).
export type { TsDiagnostic } from './diagnostics.ts';
export type { RefactorPlan, CssExtractCandidate, CssExtractAnalysis } from './refactor/plan.ts';
export type { ImportRewrite } from './refactor/extract/css-usage.ts';

/** Options bag for the overlay typecheck — tombstoned `removed` paths and an explicit
 *  diagnostic `check` scope (defaults to the overlaid files). */
interface OverlayCheck {
  removed?: readonly RepoRelPath[];
  check?: readonly RepoRelPath[];
}

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

export type { ResolvedTarget };

export interface TsPluginApi extends Plugin {
  searchSymbol(query: string, limit: number, filter?: SearchFilter): SearchView;
  findDefinition(
    target: TsTargetInput,
  ): { views: SymbolView[]; rebind?: HandleRebind } | UnresolvedTarget | string;
  findUsages(
    target: TsTargetInput,
    options: UsageOptions,
  ): { view: UsagesView; rebind?: HandleRebind } | UnresolvedTarget | string;
  expandType(
    target: TsTargetInput,
    options?: ExpandOptions,
  ): { view: TypeView; rebind?: HandleRebind } | UnresolvedTarget | string;
  /** Every semantic reference-site span for a target (all files/roles, unfiltered) — the
   *  dedup set for the textual overlay (§ text-overlay). */
  referenceSpans(target: TsTargetInput): { spans: Span[]; rebind?: HandleRebind } | string;
  /** Cross-tier API for the scss plugin (§5-L2). */
  cssModuleUsages(): CssModuleUsages;
  /** Scope-aware rewrite of the extracted file's css imports for co-extract (§2.5): repoint
   *  each import at its new sheet, inject a `<name>Legacy` import, and repoint left-behind
   *  `s.X` refs to it. Pure — operates on the given content string. */
  rewriteExtractedCss(
    fileName: string,
    content: string,
    rewrites: readonly ImportRewrite[],
  ): string;
  /** Cross-tier API (§5-L2): syntactic calls to the named functions — `t('a.b')`,
   *  `i18n.t('x')`. The i18n plugin consumes it; non-literal args are flagged `dynamic`,
   *  matching is by call name as written (no alias resolution). */
  literalCalls(fnNames: readonly string[]): LiteralCall[];
  /** Module-graph: who imports / re-exports from a module (tsconfig-paths aware). */
  importersOf(module: string): ImportersView;
  /** Symbol-anchored rename (§7): every semantic reference site as a per-file before/after
   *  pair, or a message when the position cannot be renamed. A rebound stale handle (§6)
   *  surfaces on `rebind`. The new name's legality is the post-edit typecheck's call. */
  renameSites(
    target: TsTargetInput,
    newName: string,
  ): { changes: RenameChange[]; dropped: RepoRelPath[]; rebind?: HandleRebind } | string;
  /** Typecheck post-edit `content` for each file via the overlay (§2.7/§2.8) — set, diagnose,
   *  ALWAYS clear (self-contained: the overlay never leaks into a later read as a fact).
   *  `opts.removed` tombstones moved-away paths; `opts.check` widens the diagnostic scope
   *  beyond the overlaid files (to catch a dangling import in an un-rewritten importer). */
  typecheckOverlay(
    files: readonly { path: RepoRelPath; content: string }[],
    opts?: OverlayCheck,
  ): TsDiagnostic[];
  /** Plan a file/folder move: tree move + sibling carry + import rewrite → the plain-data
   *  plan the op executes, plus the dry-run typecheck inputs. A message on a bad source/dest. */
  planMove(source: RepoRelPath, dest: RepoRelPath): Promise<RefactorPlan | string>;
  /** Plan extracting the top-level symbol at `target` to a new file `dest` via the LS
   *  "Move to a new file" refactor. A message on a bad target; a structured failure (with
   *  the `ts-ls-failures` category) when the LS refuses — never a throw. */
  planExtract(
    target: TsTargetInput,
    dest: RepoRelPath,
    opts?: { css?: boolean },
  ): Promise<RefactorPlan | string>;
  /** Plan a parameter remove/reorder on the function at `target`, applied to the declaration
   *  and every call site (§7). A message on a bad target / invalid change. */
  planChangeSignature(
    target: TsTargetInput,
    change: SignatureChange,
  ): Promise<RefactorPlan | string>;
  /** Diagnostics over the current disk-backed state for `paths` — the post-apply check
   *  (call `reindex` first so the LS sees the freshly written files). */
  diagnostics(paths: readonly RepoRelPath[]): TsDiagnostic[];
  /** Every project TS file currently in the program (under root, excl node_modules) — the
   *  whole-program diagnostic scope a content-edit op (rename/codemod) passes to
   *  `typecheckOverlay`/`diagnostics`, so a rewrite that breaks an un-edited importer is
   *  caught, never silently shipped (§2.8 completeness; the plan ops use `checkPaths`). */
  programTsFiles(): readonly RepoRelPath[];
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
      if (!resolved.ok) return missOf(resolved);
      const views = findDefinitions(warm(), resolved.abs, resolved.offset) ?? [];
      return { views, ...(resolved.rebind !== undefined ? { rebind: resolved.rebind } : {}) };
    },

    findUsages(target, options) {
      const resolved = resolve(target);
      if (!resolved.ok) return missOf(resolved);
      const view = findUsages(warm(), resolved.abs, resolved.offset, options);
      if (view === undefined) return 'no symbol at the resolved position';
      return { view, ...(resolved.rebind !== undefined ? { rebind: resolved.rebind } : {}) };
    },

    expandType(target, options) {
      const resolved = resolve(target);
      if (!resolved.ok) return missOf(resolved);
      const view = expandTypeAt(warm(), resolved.abs, resolved.offset, options);
      if (view === undefined) return 'no type information at the resolved position';
      return { view, ...(resolved.rebind !== undefined ? { rebind: resolved.rebind } : {}) };
    },

    referenceSpans(target) {
      const resolved = resolve(target);
      if (!resolved.ok) return resolved.message;
      const spans = referenceSpans(warm(), resolved.abs, resolved.offset) ?? [];
      return { spans, ...(resolved.rebind !== undefined ? { rebind: resolved.rebind } : {}) };
    },

    cssModuleUsages: () => scanCssModuleUsages(warm()),
    rewriteExtractedCss: (fileName, content, rewrites) =>
      rewriteExtractedCss(fileName, content, rewrites),

    literalCalls: (fnNames) => scanLiteralCalls(warm(), fnNames),

    importersOf: (module) => findImporters(warm(), module),

    renameSites(target, newName) {
      const resolved = resolve(target);
      if (!resolved.ok) return resolved.message;
      const outcome = computeRename(warm(), resolved.abs, resolved.offset, newName);
      if (typeof outcome === 'string') return outcome;
      return {
        changes: outcome.changes,
        dropped: outcome.dropped,
        ...(resolved.rebind !== undefined ? { rebind: resolved.rebind } : {}),
      };
    },

    typecheckOverlay(files, opts) {
      const h = warm();
      try {
        h.setOverlay(
          files.map((f) => ({ abs: h.absOf(f.path), content: f.content })),
          opts?.removed,
        );
        const checkPaths = opts?.check ?? files.map((f) => f.path);
        return collectDiagnostics(
          h,
          checkPaths.map((p) => h.absOf(p)),
        );
      } finally {
        h.clearOverlay(); // never leak the overlay into a subsequent read (§2.4)
      }
    },

    async planMove(source, dest) {
      const h = warm();
      const tree = await loadTreeFromGit(root);
      if (!isOk(tree)) return tree.failure.message;
      const options = h.service.getProgram()?.getCompilerOptions() ?? {};
      return planMove(h, tree.data, options, source, dest);
    },

    async planExtract(target, dest, opts) {
      const h = warm();
      const resolved = resolve(target);
      if (!resolved.ok) return resolved.message;
      const tree = await loadTreeFromGit(root);
      if (!isOk(tree)) return tree.failure.message;
      const options = h.service.getProgram()?.getCompilerOptions() ?? {};
      const css = opts?.css ?? false;
      const plan = planExtractTo(h, tree.data, options, resolved.abs, resolved.offset, dest, css);
      if (typeof plan !== 'string' && resolved.rebind !== undefined) plan.rebind = resolved.rebind;
      return plan;
    },

    async planChangeSignature(target, change) {
      const h = warm();
      const resolved = resolve(target);
      if (!resolved.ok) return resolved.message;
      const tree = await loadTreeFromGit(root);
      if (!isOk(tree)) return tree.failure.message;
      const options = h.service.getProgram()?.getCompilerOptions() ?? {};
      const plan = planChangeSignature(
        h,
        tree.data,
        options,
        resolved.abs,
        resolved.offset,
        change,
      );
      if (typeof plan !== 'string' && resolved.rebind !== undefined) plan.rebind = resolved.rebind;
      return plan;
    },

    diagnostics(paths) {
      const h = warm();
      return collectDiagnostics(
        h,
        paths.map((p) => h.absOf(p)),
      );
    },

    programTsFiles() {
      const h = warm();
      const program = h.service.getProgram();
      if (program === undefined) return [];
      const out: RepoRelPath[] = [];
      for (const sf of program.getSourceFiles()) {
        if (sf.fileName.includes('/node_modules/')) continue; // deps + bundled lib.d.ts
        const rel = h.relOf(sf.fileName);
        // relOf returns an ABSOLUTE path for a file OUTSIDE root (a path-mapped / symlinked
        // source dir, project-references spillover) — not ours to typecheck. A repo-relative
        // path is never absolute, so this filters exactly the out-of-root files.
        if (path.isAbsolute(String(rel))) continue;
        out.push(rel);
      }
      return out;
    },
  };
}
function tsVersionString(): string {
  // Bundled TS for now (project-own TS resolution is roadmap §19); stated via status.
  return `bundled-ts`;
}

/** The shared §6 miss chokepoint for every SymbolId-taking read method: a failed resolve
 *  that carries a `{status:'gone'}` rebind surfaces structurally (so the op states it on
 *  `Result.handle`); a miss with no held handle stays a plain message. Lifting this here
 *  keeps `findDefinition`/`findUsages`/`expandType` uniform — one of them surfacing gone and
 *  the others flattening it would be a silent, inconsistent retarget signal. */
function missOf(resolved: { message: string; rebind?: HandleRebind }): UnresolvedTarget | string {
  return resolved.rebind !== undefined
    ? { unresolved: resolved.message, rebind: resolved.rebind }
    : resolved.message;
}
