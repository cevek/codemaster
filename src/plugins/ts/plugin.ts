// The `ts` plugin — owner of the TypeScript domain (§5-L2): the long-lived LS (lazy
// warm), target resolution (SymbolId / file:line:col / name), proof-carrying rebind
// (§6), and the cross-tier `cssModuleUsages` other plugins consume. Public API only;
// internals (ls-host, queries) stay behind this module.
/* eslint-disable max-lines -- temporary: LS-read wiring to be split into a sub-module, see docs/backlog.md */

import * as path from 'node:path';
import type { PluginRegistry, FreshnessFingerprint } from '../../core/plugin.ts';
import type { RepoRelPath } from '../../core/brands.ts';
import type { HandleRebind } from '../../core/ids.ts';
import { createTsProjectHost, type TsProjectHost } from './ls-host.ts';
import { findDefinitions } from './definitions.ts';
import { findUsages, referenceSpans } from './usages.ts';
import { findUsagesMerged } from './usages-merge.ts';
import { expandTypeAt } from './type-expand.ts';
import { findConstructionSites } from './construction-sites.ts';
import { findDiscriminationSites } from './discrimination-sites.ts';
import { scanJsxCallSites } from './jsx-call-sites.ts';
import { scanJsxChildSites } from './jsx-child-sites.ts';
import { scanFieldRenderSites } from './field-render-sites.ts';
import { firstParamTypeMembers } from './first-param-members.ts';
import { collectWideningSinks } from './type-widening.ts';
import { overlaySymbolType } from './overlay-type.ts';
import type { UnresolvedTarget } from './query-types.ts';
import { searchSymbols } from './search.ts';
import { scanCssModuleUsages } from './css-modules.ts';
import { scanClassNameLiterals } from './class-name-literals.ts';
import { findImporters } from './importers.ts';
import { findUnusedExports } from './unused-exports.ts';
import { computeRename } from './refactor/rename/rename-sites.ts';
import { collectDiagnostics } from './diagnostics.ts';
import { planMove } from './refactor/imports/plan-move.ts';
import { planExtractTo } from './refactor/extract/move-to-file.ts';
import { planMoveSymbolTo } from './refactor/extract/move-to-existing.ts';
import { rewriteExtractedCss } from './refactor/extract/css-usage.ts';
import { planChangeSignature } from './refactor/change-signature/plan.ts';
import {
  resolveTarget,
  resolveAllByName,
  type ResolvedTarget,
  type TsTargetInput,
} from './resolve-target.ts';
import { detectCodemodCaptures } from './refactor/capture/codemod.ts';
import { createScanMemos, createPlanningHelpers, resolvedScan } from './plugin-helpers.ts';
import type { RefactorPlan } from './refactor/plan.ts';
import type { TsPluginApi } from './api.ts';

// Re-export the shapes ops consume so they go through the plugin's public surface rather
// than reaching into internal query/refactor modules (§5-L3).
export type { TsDiagnostic } from './diagnostics.ts';
export type {
  RefactorPlan,
  CssExtractCandidate,
  CssExtractAnalysis,
  PlanningOverlay,
} from './refactor/plan.ts';
export type { ImportRewrite } from './refactor/extract/css-usage.ts';
// Capture-safety types (§ capture-safety). Envelope formatting lives in the ops layer.
export type { Capture } from './refactor/capture/types.ts';
export type { CodemodEdit, CodemodRegion } from './refactor/capture/codemod.ts';
export type { UnusedExportView } from './unused-exports.ts';
// Cross-tier call-scan shapes the i18n plugin consumes — through this surface, never the scan
// files (§5-L2 / src/README rule 5).
export type { CallMatchSpec, LiteralCallProvenance } from './call-scan-shared.ts';
export type { ConstructionSite, ConstructionTarget } from './construction-sites.ts';
export type { DiscriminationSite, DiscriminationTargetView } from './discrimination-sites.ts';
export type { JsxCallSite, JsxOpaqueRef, JsxCallSitesView } from './jsx-call-sites.ts';
export type { JsxChildSite, JsxChildAttr, JsxChildSitesView } from './jsx-child-sites.ts';
export type { ParamTypeMember, ParamTypeMembersView } from './first-param-members.ts';
export type { WideningSink, WideningEndpoint } from './type-widening.ts';
// Pure syntactic helper exposed through the public surface (a stateless AST scan, not warm-LS
// state): the rename-completeness signal's alias half. See rename-sites.ts for the contract.
export { findReExportAliasSites } from './refactor/rename/rename-sites.ts';

export type { ResolvedTarget, TsTargetInput };
export type { TsPluginApi };

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

  // Per-instance bookkeeping (the `literalCalls` memo + transaction planning-overlay helpers) lives
  // in plugin-helpers.ts to keep this file under the line cap. The memo MUST be cleared on dispose.
  const memos = createScanMemos(warm);
  const { runWithOverlay, planUnderOverlay } = createPlanningHelpers(warm, root);

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
      // Back to cold — never let a slot survive into a re-warm (§3.1).
      memos.literalCalls.clear();
      memos.callArgShapes.clear();
      memos.functionDeclarations.clear();
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
    statusDetail() {
      // Only once warm — status must not trigger a lazy warm (it would change the cold/warm
      // freshness it reports). Lists the tsconfigs whose programs back cross-program usages /
      // dead-code (Task G); shown only when there is a sibling beyond the primary.
      if (host === undefined) return undefined;
      const labels = host.programLabels();
      return labels.length > 1 ? `programs: ${labels.join(', ')}` : undefined;
    },

    searchSymbol: (query, limit, filter) => searchSymbols(warm(), query, limit, filter),

    findDefinition(target) {
      const resolved = resolve(target);
      if (!resolved.ok) return missOf(resolved);
      const views = findDefinitions(warm(), resolved.abs, resolved.offset) ?? [];
      return { views, ...(resolved.rebind !== undefined ? { rebind: resolved.rebind } : {}) };
    },

    findUsages(target, options) {
      // mergeDeclarations: union usages across ALL same-named declarations (only meaningful for a
      // NAME target — a SymbolId/position already addresses one declaration). Per-site provenance is
      // preserved (`UsageView.decls`), so unrelated same-named symbols are never conflated (§3.3).
      const byName = target.name !== undefined && target.symbolId === undefined;
      if (options.mergeDeclarations === true && byName && target.name !== undefined) {
        const decls = resolveAllByName(warm(), target.name);
        if (typeof decls === 'string') return decls;
        const view = findUsagesMerged(warm(), decls, options);
        if (view === undefined) return 'no references for any declaration of this name';
        return { view };
      }
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

    constructionSites(target, options) {
      const resolved = resolve(target);
      if (!resolved.ok) return missOf(resolved);
      const view = findConstructionSites(warm(), resolved.abs, resolved.offset, options);
      if (typeof view === 'string') return view;
      return { view, ...(resolved.rebind !== undefined ? { rebind: resolved.rebind } : {}) };
    },

    discriminationSites(target, options) {
      const resolved = resolve(target);
      if (!resolved.ok) return missOf(resolved);
      const view = findDiscriminationSites(warm(), resolved.abs, resolved.offset, options);
      if (typeof view === 'string') return view;
      return { view, ...(resolved.rebind !== undefined ? { rebind: resolved.rebind } : {}) };
    },

    jsxCallSites: (target) =>
      resolvedScan(resolve, warm, target, scanJsxCallSites, 'no symbol at the resolved position'),

    firstParamTypeMembers: (target) =>
      resolvedScan(
        resolve,
        warm,
        target,
        firstParamTypeMembers,
        'no type information at the resolved position',
      ),

    jsxChildSites: (target) =>
      resolvedScan(resolve, warm, target, scanJsxChildSites, 'no source at the resolved position'),

    wideningSinksAt: (target) =>
      resolvedScan(
        resolve,
        warm,
        target,
        collectWideningSinks,
        'no value at the resolved position',
      ),

    fieldRenderSites: (target) =>
      resolvedScan(
        resolve,
        warm,
        target,
        scanFieldRenderSites,
        'no symbol at the resolved position',
      ),

    cssModuleUsages: () => scanCssModuleUsages(warm()),
    classNameLiterals: () => scanClassNameLiterals(warm()),
    rewriteExtractedCss: (fileName, content, rewrites) =>
      rewriteExtractedCss(fileName, content, rewrites),

    literalCalls: (spec) => memos.literalCalls.call(spec),
    callArgShapes: (spec) => memos.callArgShapes.call(spec),
    functionDeclarations: () => memos.functionDeclarations.call(),

    importersOf: (module) => findImporters(warm(), module),

    unusedExports: (filter) => findUnusedExports(warm(), filter),

    renameSites(target, newName, overlay) {
      return runWithOverlay(overlay, () => {
        const resolved = resolve(target);
        if (!resolved.ok) return resolved.message;
        // Fan the site computation across programs ONLY off the transaction path: an `overlay`
        // means the primary carries a planning overlay, so a sibling reading stale disk is unsound
        // (ls-host TRAP). The cross-program §2.8 gate still backstops a transaction dangle.
        const outcome = computeRename(
          warm(),
          resolved.abs,
          resolved.offset,
          newName,
          overlay === undefined,
        );
        if (typeof outcome === 'string') return outcome;
        return {
          ...outcome,
          ...(resolved.rebind !== undefined ? { rebind: resolved.rebind } : {}),
        };
      });
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

    planMove(source, dest, overlay) {
      return planUnderOverlay(overlay, (h, tree, options) =>
        planMove(h, tree, options, source, dest, overlay),
      );
    },

    planExtract(target, dest, opts, overlay) {
      const css = opts?.css ?? false;
      return planUnderOverlay(overlay, (h, tree, options) =>
        withRebind(resolve(target), (r) =>
          planExtractTo(h, tree, options, r.abs, r.offset, dest, css, overlay),
        ),
      );
    },

    planMoveSymbol(target, dest, overlay) {
      return planUnderOverlay(overlay, (h, tree, options) =>
        withRebind(resolve(target), (r) =>
          planMoveSymbolTo(h, tree, options, r.abs, r.offset, dest, overlay),
        ),
      );
    },

    planChangeSignature(target, change, overlay) {
      return planUnderOverlay(overlay, (h, tree, options) =>
        withRebind(resolve(target), (r) =>
          // Fan call-site search across programs only off the transaction path (overlay present →
          // primary carries a planning overlay; a sibling reading stale disk is unsound, ls-host TRAP).
          planChangeSignature(h, tree, options, r.abs, r.offset, change, overlay === undefined),
        ),
      );
    },

    diagnostics(paths) {
      const h = warm();
      return collectDiagnostics(
        h,
        paths.map((p) => h.absOf(p)),
      );
    },

    gateAcross: (files, scope) => warm().gateAcross(files, scope),

    diagnosticsAcross: (scope, restrictTo) => warm().diagnosticsAcross(scope, restrictTo),

    overlaySymbolType: (declFile, name, overlay) =>
      overlaySymbolType(warm(), declFile, name, overlay),

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

    fileText(p) {
      const h = warm();
      // sourceFileAcross prefers the primary program and only builds siblings if the file lives
      // solely in one — so the read basis matches the gate's baseline (same VFS-parsed bytes).
      return h.sourceFileAcross(h.absOf(p))?.sf.text;
    },

    allProgramTsFiles() {
      // Union every loaded program's source files (primary + siblings), deduped — so a codemod's
      // whole-program gate scope spans a SIBLING-only importer (a `test/**` file the primary never
      // compiles) and a cross-program break is caught, not silently shipped. Builds the siblings,
      // but a crossFileScope edit already fans the gate across them, so the cost is already paid.
      const h = warm();
      const seen = new Set<string>();
      const out: RepoRelPath[] = [];
      for (const program of h.programs()) {
        const p = program.getProgram();
        if (p === undefined) continue;
        for (const sf of p.getSourceFiles()) {
          if (sf.fileName.includes('/node_modules/')) continue;
          const rel = h.relOf(sf.fileName);
          if (path.isAbsolute(String(rel)) || seen.has(String(rel))) continue;
          seen.add(String(rel));
          out.push(rel);
        }
      }
      return out;
    },

    undiscoveredProgramLabels() {
      return warm().undiscoveredProgramLabels();
    },

    loadPrograms(paths) {
      return warm().loadPrograms(paths);
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

/** Resolve→plan→attach-rebind: the shared shape of every symbol-anchored plan method. On a failed
 *  resolve, the message; otherwise `body`'s plan with the §6 rebind stamped on (when the held handle
 *  moved). Keeps the four overlay-aware plan methods to one expression each. */
function withRebind(
  resolved: ResolvedTarget,
  body: (r: { abs: string; offset: number }) => RefactorPlan | string,
): RefactorPlan | string {
  if (!resolved.ok) return resolved.message;
  const plan = body(resolved);
  if (typeof plan !== 'string' && resolved.rebind !== undefined) plan.rebind = resolved.rebind;
  return plan;
}
