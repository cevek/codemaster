// The `ts` plugin — owner of the TypeScript domain (§5-L2): the long-lived LS (lazy
// warm), target resolution (SymbolId / file:line:col / name), proof-carrying rebind
// (§6), and the cross-tier `cssModuleUsages` other plugins consume. Public API only;
// internals (ls-host, queries) stay behind this module.

import * as path from 'node:path';
import type { Plugin, PluginRegistry, FreshnessFingerprint } from '../../core/plugin.ts';
import type { RepoRelPath } from '../../core/brands.ts';
import type { HandleRebind } from '../../core/ids.ts';
import { createTsProjectHost, type TsProjectHost } from './ls-host.ts';
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
import {
  findUnusedExports,
  type TsUnusedExportsFilter,
  type UnusedExportsView,
} from './unused-exports.ts';
import { computeRename, type RenameOutcome } from './refactor/rename/rename-sites.ts';
import { collectDiagnostics, type TsDiagnostic } from './diagnostics.ts';
import { planMove } from './refactor/imports/plan-move.ts';
import { planExtractTo } from './refactor/extract/move-to-file.ts';
import { rewriteExtractedCss, type ImportRewrite } from './refactor/extract/css-usage.ts';
import { planChangeSignature, type SignatureChange } from './refactor/change-signature/plan.ts';
import { loadTreeFromGit } from './refactor/tree/build.ts';
import { isOk } from '../../common/result/narrow.ts';
import { resolveTarget, type ResolvedTarget, type TsTargetInput } from './resolve-target.ts';
import type { RefactorPlan } from './refactor/plan.ts';
import type { Capture } from './refactor/capture/types.ts';
import { detectCodemodCaptures, type CodemodEdit } from './refactor/capture/codemod.ts';

// Re-export the shapes ops consume so they go through the plugin's public surface rather
// than reaching into internal query/refactor modules (§5-L3).
export type { TsDiagnostic } from './diagnostics.ts';
export type { RefactorPlan, CssExtractCandidate, CssExtractAnalysis } from './refactor/plan.ts';
export type { ImportRewrite } from './refactor/extract/css-usage.ts';
// Capture-safety types (§ capture-safety). Envelope formatting lives in the ops layer.
export type { Capture } from './refactor/capture/types.ts';
export type { CodemodEdit, CodemodRegion } from './refactor/capture/codemod.ts';
export type { UnusedExportView } from './unused-exports.ts';
// Pure syntactic helper exposed through the public surface (a stateless AST scan, not warm-LS
// state): the rename-completeness signal's alias half. See rename-sites.ts for the contract.
export { findReExportAliasSites } from './refactor/rename/rename-sites.ts';

/** Options bag for the overlay typecheck — tombstoned `removed` paths and an explicit
 *  diagnostic `check` scope (defaults to the overlaid files). */
interface OverlayCheck {
  removed?: readonly RepoRelPath[];
  check?: readonly RepoRelPath[];
}

export type { ResolvedTarget, TsTargetInput };

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
  /** Cross-tier API (§5-L2): calls to the named functions — `t('a.b')`, `i18n.t('x')`. The
   *  i18n plugin consumes it; non-literal args are flagged `dynamic`. Matching is IMPORT-
   *  resolved via the checker — a simple name matches a named-import alias (`import { t as tr }`),
   *  a dotted name matches an aliased-base member access (`import { i18n as i }; i.t`). Confined
   *  to user-named bindings (no bare-`t`-matches-`obj.t()`, no destructure-rename) so a match is
   *  strong enough to assert a usage (§3). `fn` is the matched configured name, not the written
   *  callee. */
  literalCalls(fnNames: readonly string[]): LiteralCall[];
  /** Module-graph: who imports / re-exports from a module (tsconfig-paths aware). */
  importersOf(module: string): ImportersView;
  /** Locally-declared exports with no importer/usage anywhere (semantic, via the LS). A
   *  barrel-/`export *`-/dynamic-`import()`-reached export demotes to `partial` ("could not
   *  prove dead"), never `certain` unused. Bounded: the candidate set is scoped + hard-capped. */
  unusedExports(filter?: TsUnusedExportsFilter): UnusedExportsView;
  /** Symbol-anchored rename (§7): every semantic reference site as a per-file before/after
   *  pair, or a message when the position cannot be renamed. A rebound stale handle (§6)
   *  surfaces on `rebind`. The new name's legality is the post-edit typecheck's call. */
  renameSites(
    target: TsTargetInput,
    newName: string,
  ): (RenameOutcome & { rebind?: HandleRebind }) | string;
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
  /** Capture-safety for `codemod` (§): a metavar-preserved reference inside a rewritten span that
   *  silently re-resolves to a DIFFERENT declaration (type-compatible → invisible to §2.8). Keeps
   *  the LS access in the plugin (ops never reach the LS directly — §5-L3). */
  detectCodemodCaptures(edits: readonly CodemodEdit[]): Capture[];
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

  // Symbol-addressed reads funnel through one resolver (SymbolId / file:line:col / name +
  // §6 rebind) — the logic lives in resolve-target.ts; here it just binds the warm host.
  const resolve = (target: TsTargetInput): ResolvedTarget => resolveTarget(warm(), target);

  return {
    id: 'ts',
    version: '0.1.0',
    deps: [],
    // Bundled TS for now (project-own TS resolution is roadmap §19); stated via status.
    tsVersion: `bundled-ts`,

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

    unusedExports: (filter) => findUnusedExports(warm(), filter),

    renameSites(target, newName) {
      const resolved = resolve(target);
      if (!resolved.ok) return resolved.message;
      const outcome = computeRename(warm(), resolved.abs, resolved.offset, newName);
      if (typeof outcome === 'string') return outcome;
      return { ...outcome, ...(resolved.rebind !== undefined ? { rebind: resolved.rebind } : {}) };
    },

    detectCodemodCaptures(edits) {
      return detectCodemodCaptures(warm(), edits);
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
