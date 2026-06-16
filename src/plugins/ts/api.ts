// The `ts` plugin's PUBLIC API surface (the `TsPluginApi` interface) — split out of `plugin.ts`
// to keep that file under the line cap as the op set grows. The factory (`createTsPlugin`) lives in
// `plugin.ts` and implements this; ops depend on this interface, never on the internal query /
// refactor modules (§5-L3).

import type { Plugin } from '../../core/plugin.ts';
import type { RepoRelPath } from '../../core/brands.ts';
import type { HandleRebind } from '../../core/ids.ts';
import type { Span } from '../../core/span.ts';
import type {
  ExpandOptions,
  SymbolView,
  TypeView,
  UnresolvedTarget,
  UsageOptions,
  UsagesView,
} from './query-types.ts';
import type { SearchFilter, SearchView } from './search.ts';
import type { ConstructionSitesOptions, ConstructionSitesView } from './construction-sites.ts';
import type { CssModuleUsages } from './css-modules.ts';
import type { CallMatchSpec, LiteralCallsResult } from './call-scan-shared.ts';
import type { ImportersView } from './importers.ts';
import type { TsUnusedExportsFilter, UnusedExportsView } from './unused-exports.ts';
import type { RenameOutcome } from './refactor/rename/rename-sites.ts';
import type { TsDiagnostic } from './diagnostics.ts';
import type { ImportRewrite } from './refactor/extract/css-usage.ts';
import type { SignatureChange } from './refactor/change-signature/plan.ts';
import type { CodemodEdit } from './refactor/capture/codemod.ts';
import type { Capture } from './refactor/capture/types.ts';
import type { TsTargetInput } from './resolve-target.ts';
import type { RefactorPlan, PlanningOverlay } from './refactor/plan.ts';

/** Options bag for the overlay typecheck — tombstoned `removed` paths and an explicit
 *  diagnostic `check` scope (defaults to the overlaid files). */
interface OverlayCheck {
  removed?: readonly RepoRelPath[];
  check?: readonly RepoRelPath[];
}

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
  /** Type-aware "what builds a T?": the object-literal expressions the live checker deems
   *  assignable to the TYPE at `target` (factory returns, array elements, var initializers,
   *  call args), each proof-carrying with its enclosing declaration + an honest confidence (a
   *  vacuous `any` / bare-generic boundary demotes below `certain`). The complement to
   *  `findUsages` — grep cannot answer it. Bounded: the assignability checks are capped, the
   *  cap reported as truncation. A `string` on a target that cannot be resolved to a type. */
  constructionSites(
    target: TsTargetInput,
    options: ConstructionSitesOptions,
  ): { view: ConstructionSitesView; rebind?: HandleRebind } | UnresolvedTarget | string;
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
  /** Cross-tier API (§5-L2): calls to the configured functions — `t('a.b')`, `i18n.t('x')`, a
   *  hook's `const { t } = useTranslation()`. The i18n plugin consumes it; non-literal args are
   *  flagged `dynamic`. Two models (chosen by `spec.module`): by-NAME (alias-aware syntactic
   *  match, no module) or by-IDENTITY (callee binding resolves to a function FROM the configured
   *  module — kills the same-named-`t` false positive, catches renamed destructure / namespace
   *  alias). Each match carries `provenance` (how it resolved). MEMOIZED on `freshness()` + the
   *  spec, so a batch of i18n ops scans once. */
  literalCalls(spec: CallMatchSpec): LiteralCallsResult;
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
    overlay?: PlanningOverlay,
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
  planMove(
    source: RepoRelPath,
    dest: RepoRelPath,
    overlay?: PlanningOverlay,
  ): Promise<RefactorPlan | string>;
  /** Plan extracting the top-level symbol at `target` to a new file `dest` via the LS
   *  "Move to a new file" refactor. A message on a bad target; a structured failure (with
   *  the `ts-ls-failures` category) when the LS refuses — never a throw. */
  planExtract(
    target: TsTargetInput,
    dest: RepoRelPath,
    opts?: { css?: boolean },
    overlay?: PlanningOverlay,
  ): Promise<RefactorPlan | string>;
  /** Plan moving the top-level symbol at `target` into the EXISTING file `dest` (§7) — the dest's
   *  imports/exports are merged, every importer rewritten. A message on a bad target / dest. */
  planMoveSymbol(target: TsTargetInput, dest: RepoRelPath): Promise<RefactorPlan | string>;
  /** Plan a parameter remove/reorder on the function at `target`, applied to the declaration
   *  and every call site (§7). A message on a bad target / invalid change. */
  planChangeSignature(
    target: TsTargetInput,
    change: SignatureChange,
    overlay?: PlanningOverlay,
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
