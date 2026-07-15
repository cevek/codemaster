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
import type { ProgramsLoadReport } from './program/explicit-load.ts';
import type { Result } from '../../core/result.ts';
import type { SearchFilter, SearchView } from './search.ts';
import type { CatalogueFilter, FileNames } from './syntactic-catalogue.ts';
import type { ConfigMembership } from './program/config-membership.ts';
import type { ConstructionSitesOptions, ConstructionSitesView } from './construction-sites.ts';
import type {
  DiscriminationSitesOptions,
  DiscriminationSitesView,
} from './discrimination-sites.ts';
import type { CssModuleUsages } from './css-modules.ts';
import type { ClassNameLiteralsView } from './class-name-literals.ts';
import type { CallArgShapesResult, CallMatchSpec, LiteralCallsResult } from './call-scan-shared.ts';
import type { FunctionDeclarationsResult } from './function-declarations.ts';
import type { JsxCallSitesView } from './jsx-call-sites.ts';
import type { JsxChildSitesView } from './jsx-child-sites.ts';
import type { FieldRenderSitesView } from './field-render-sites.ts';
import type { MemberUsagesView, MemberUsagesOptions } from './member-usages.ts';
import type { ParamTypeMembersView } from './first-param-members.ts';
import type { WideningSinksView } from './type-widening.ts';
import type { OverlaySymbolType } from './overlay-type.ts';
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
import type { GateScope } from './program-gate.ts';

/** Options bag for the overlay typecheck — tombstoned `removed` paths and an explicit
 *  diagnostic `check` scope (defaults to the overlaid files). */
interface OverlayCheck {
  removed?: readonly RepoRelPath[];
  check?: readonly RepoRelPath[];
}

export interface TsPluginApi extends Plugin {
  searchSymbol(query: string, limit: number, filter?: SearchFilter): SearchView;
  /** `search_symbol { syntactic: true }` — a raw AST scan (no program build; NEVER warms the LS, so
   *  it survives / avoids the multi-program navto OOM on huge monorepos). COMPLETE for declarations
   *  in the §10 git source surface UNDER the workspace root (≥ navto's recall there), every site
   *  `provenance:'syntactic'`, real declarations ranked first, noisier (extra import / re-export
   *  sites) and not byte-identical to the LS. An outside-root tsconfig include/reference is NOT
   *  scanned (use the default for those). Returns a `ToolFailure` on git / @internal-TS unavailability
   *  — never a false empty. Default `searchSymbol` is unchanged (t-515730). */
  searchSymbolSyntactic(query: string, limit: number, filter?: SearchFilter): Result<SearchView>;
  /** `list_symbols` catalogue core (t-143952): every declared NAME per file in the §10 git surface,
   *  via the SAME no-program surface parse as the syntactic search — NEVER warms the LS (OOM-safe
   *  first-contact browse). Complete for declarations under the root; a `ToolFailure` on git /
   *  @internal-TS unavailability, never a false empty. */
  listSymbols(filter: CatalogueFilter): Result<FileNames[]>;
  /** `list_symbols` grouping layer (t-143952): file→tsconfig ownership for per-config grouping, host-
   *  free + bounded. Never warms the LS, never throws — an over-bound/failed pass returns `degraded`
   *  and the op falls back to a single flat group. */
  configMembership(): ConfigMembership;
  findDefinition(
    target: TsTargetInput,
  ): { views: SymbolView[]; rebind?: HandleRebind } | UnresolvedTarget | string;
  findUsages(
    target: TsTargetInput,
    options: UsageOptions,
  ): { view: UsagesView; rebind?: HandleRebind } | UnresolvedTarget | string;
  /** The distinct same-named declarations a bare `name` resolves to — the merge candidates
   *  `mergeDeclarations` would union. `find_usages` reads the count to append the merge hint to the
   *  ambiguous hard-FAIL (>1 distinct declaration), so the discoverability check is shape-based
   *  (a real count), never a substring match on the failure message. Empty when the name resolves
   *  nowhere. */
  sameNamedDeclarations(name: string): SymbolView[];
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
  /** Cross-tier API for the scss plugin (§5-L2): class tokens applied via string `className="…"`
   *  (and `clsx`/`classnames` string args / object keys) across every program — how a GLOBAL
   *  (non-`.module.*`) sheet's classes are referenced. A generic SYNTACTIC scan; a dynamic
   *  className contributes no token (never guessed). Whole-program, bounded. */
  classNameLiterals(): ClassNameLiteralsView;
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
  /** Cross-tier API (§5-L2): the classified SHAPE of every configured call's arguments — the seam
   *  framework plugins (e.g. react-query) consume. Same `CallMatchSpec` + matching models as
   *  `literalCalls` (by-name / by-identity). GENERIC: argument values are classified by syntactic
   *  shape (string/number/array-segment/object-prop/function/identifier/…), literals `certain` and
   *  indeterminate forms `dynamic`; each call carries its enclosing declaration (chainable id) and
   *  the nearest enclosing matched call (`enclosingCallId`) so a nested call (e.g.
   *  `invalidateQueries` in an `onSuccess`) links to its container. Zero framework policy here.
   *  MEMOIZED on `freshness()` + the spec. */
  callArgShapes(spec: CallMatchSpec): CallArgShapesResult;
  /** Cross-tier API (§5-L2): every function-like declaration (`function`/arrow/function-expression/
   *  method/call-wrapped) with a syntactic `returnsJsx` TSX-language fact + confidence — the seam
   *  the `react` plugin consumes for component/hook detection. GENERIC: no react convention here
   *  (PascalCase / `use*` live in plugins/react). The name-token span is a chainable target.
   *  MEMOIZED on `freshness()`. */
  functionDeclarations(): FunctionDeclarationsResult;
  /** Cross-tier API (§5-L2): the JSX call-sites of the symbol at `target` — per `<Tag .../>`
   *  reference, the named attributes passed + whether it `{...spreads}` — plus the references
   *  that are NOT readable JSX elements (factory `createElement` calls, value reads/writes like
   *  `memo(C)`), which obscure the passed set. Anchored on `findReferences` (alias-safe). The seam
   *  the `react` plugin's unused-props read-model consumes; zero framework policy here. Bounded:
   *  the reference set is hard-capped (§19) and the cap reported as `truncated`. */
  jsxCallSites(
    target: TsTargetInput,
  ): { view: JsxCallSitesView; rebind?: HandleRebind } | UnresolvedTarget | string;
  /** Cross-tier API (§5-L2): the apparent-type members of the FIRST parameter of the function at
   *  `target` — the checker's own member-merge, so `extends`/intersection props arrive flattened
   *  (what `expandType` cannot do — it dispatches a union/intersection to arm strings). The seam
   *  the `react` plugin reads a component's DECLARED props from; "first param = props" is react's
   *  policy, not here. Each member carries its declaration-name proof span. */
  firstParamTypeMembers(
    target: TsTargetInput,
  ): { view: ParamTypeMembersView; rebind?: HandleRebind } | UnresolvedTarget | string;
  /** Cross-tier API (§5-L2, Phase 6): ONE forward flow step from the VALUE at `target` — its own
   *  type plus every immediate sink it flows into (var-init / arg→param / return / reassignment)
   *  with a per-sink widening verdict (literal→primitive, narrowed→declared, →any/unknown,
   *  union-widen) + a `next` position to continue from. The `trace_type_widening` walk drives the
   *  recursion (depth/visited/node-cap) over `next`. The source type is read at the value's OWN
   *  declaration (never the arg position — contextual typing would hide every literal widening).
   *  An `any`/`unknown` boundary is flagged `dynamic` and is a leaf (§3.3). A `string` when the
   *  target is not a value with a symbol. */
  wideningSinksAt(
    target: TsTargetInput,
  ): { view: WideningSinksView; rebind?: HandleRebind } | UnresolvedTarget | string;
  /** Cross-tier API (§5-L2): the JSX elements rendered in the BODY of the declaration at `target` —
   *  per `<Tag .../>`, its tag-name span (a chainable `classify` target), the named attributes with
   *  their value source + a bare-identifier value flagged (`{ident}` — the as-is/rename forward
   *  signal), and whether it `{...spreads}`. GENERIC syntactic scan (JSX is a TSX-language fact,
   *  like `jsxCallSites`); zero framework policy — trace ops apply the react convention via
   *  `classify` on the tag span. OVER-collects all body JSX (incl. callback / attr-value position):
   *  a value can flow through a `.map(…)` closure or a render-prop, so under-collecting would lie
   *  (§3.4). Bounded: single-body scan (§19), site set hard-capped and reported. */
  jsxChildSites(
    target: TsTargetInput,
  ): { view: JsxChildSitesView; rebind?: HandleRebind } | UnresolvedTarget | string;
  /** Cross-tier API (§5-L2): the member-read sites of the PROPERTY symbol at `target` — a different
   *  projection of the same `findReferences` primitive `findUsages` rides (member-level by
   *  construction: references of a property are its `obj.email` accesses, alias-safe), each tagged
   *  with the TSX-language fact `trace_field_to_render` maps to a render verdict — the nearest
   *  enclosing JSX position (intrinsic-host vs value-based element, child vs attribute) + the
   *  enclosing declaration + a destructure flag. Zero framework policy here. Bounded: the reference
   *  set is hard-capped (§19) and the cap reported as `truncated`. */
  fieldRenderSites(
    target: TsTargetInput,
  ): { view: FieldRenderSitesView; rebind?: HandleRebind } | UnresolvedTarget | string;
  /** The reference sites of a specific MEMBER of the type at `target` (`member_usages`): resolve the
   *  member through the live checker (`getApparentType(T).getProperty` — inherited/intersection
   *  flattened), then the sites of THAT member symbol, classified read/write/destructure. IDENTITY BY
   *  CONSTRUCTION — a same-named member on an unrelated type is never matched (no separate gate).
   *  Rides the shared `scanMemberRefs` core. A `string` when the type has no such member. */
  memberUsages(
    target: TsTargetInput,
    member: string,
    options: MemberUsagesOptions,
  ): { view: MemberUsagesView; rebind?: HandleRebind } | UnresolvedTarget | string;
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
  /** The §2.8 write gate fanned across EVERY program the edit touches (Task G for WRITES) — the
   *  overlay typecheck on each affected program PLUS the disk baseline over the same set, so a
   *  cross-program dangle (a `test/**` reference left un-rewritten), OR a moved file erroneous under
   *  a disjoint dest program's compilerOptions, is caught — not just primary-program errors.
   *  `scope.anchor` picks the affected programs (a program OWNS a file when it contains it OR its
   *  glob would — so a not-yet-created move/extract dest pulls in the program whose glob owns it);
   *  `scope.check` is the diagnostic scope, passed identically to each (every program diagnoses only
   *  the files it contains). Returns both diagnostic sets sampled symmetrically (→
   *  `buildTypecheckField`), the `programs` actually checked, and any `degraded` sibling labels whose
   *  LS threw (skipped with a reason; the primary's throw is never swallowed — it fails honestly). */
  gateAcross(
    files: readonly { path: RepoRelPath; content: string }[],
    scope: GateScope,
  ): { baseline: TsDiagnostic[]; overlay: TsDiagnostic[]; programs: string[]; degraded: string[] };
  /** Disk diagnostics across every affected program — the post-apply half of `gateAcross`
   *  (call `reindex` first so each program's LS sees the freshly written files). `restrictTo` pins
   *  the program set to the pre-apply baseline's (`gateAcross().programs`), so a move that shifts
   *  program membership can't mis-count a newly-sampled program's pre-existing errors as introduced. */
  diagnosticsAcross(scope: GateScope, restrictTo?: readonly string[]): TsDiagnostic[];
  /** The resolved TYPE of the top-level symbol `name` in `declFile`, BEFORE and under the trial
   *  `overlay` — the FACT behind `impact_type_error`'s clean widen-to-`any` masking guard: a trial
   *  edit can collapse the edited symbol's own type to `any` with NO intra-file error, silencing
   *  downstream errors the diff-of-diagnostics cannot see. `collapse` marks an `any`/`unknown` type
   *  (tested on each state's flags INDEPENDENTLY — a cross-checker assignability relation between two
   *  program versions is invalid); for a CALLABLE symbol the RETURN type's collapse counts (a
   *  function's masking vector is `fn()` becoming `any`, not the `() => any` value). `undefined` when
   *  the symbol can't be resolved to a single top-level declaration in either state (removed / renamed
   *  / ambiguous) OR lives outside the PRIMARY program (the overlay is primary-only) — the op then
   *  makes no widen claim (conservative). The overlay is always cleared; it never leaks into a later read. */
  overlaySymbolType(
    declFile: RepoRelPath,
    name: string,
    overlay: readonly { path: RepoRelPath; content: string }[],
  ): OverlaySymbolType | undefined;
  /** Plan a file/folder move: tree move + sibling carry + import rewrite → the plain-data
   *  plan the op executes, plus the dry-run typecheck inputs. A message on a bad source/dest. */
  planMove(
    source: RepoRelPath,
    dest: RepoRelPath,
    overlay?: PlanningOverlay,
  ): Promise<RefactorPlan | string>;
  /** Plan extracting the top-level symbol at `target` to a NEW file `dest` via the LS
   *  "Move to file" refactor (dest as the not-yet-existing `targetFile`). A message on a bad
   *  target; a structured failure (with the `ts-ls-failures` category) when the LS refuses —
   *  never a throw. */
  planExtract(
    target: TsTargetInput,
    dest: RepoRelPath,
    opts?: { css?: boolean },
    overlay?: PlanningOverlay,
  ): Promise<RefactorPlan | string>;
  /** Plan moving the top-level symbol at `target` into the EXISTING file `dest` (§7) — the dest's
   *  imports/exports are merged, every importer rewritten. A message on a bad target / dest.
   *  `overlay` (a `transaction` step ≥2's cumulative prior-step state) plans against prior steps'
   *  edits, never pre-transaction disk; absent for the standalone op (plans against disk). */
  planMoveSymbol(
    target: TsTargetInput,
    dest: RepoRelPath,
    overlay?: PlanningOverlay,
  ): Promise<RefactorPlan | string>;
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
  /** Like `programTsFiles` but spanning EVERY loaded program (primary + siblings), deduped — the
   *  whole-program scope for a content-edit op whose changeset is NOT complete AND can break a
   *  SIBLING-only file (a `codemod` matching a shared `src/**` symbol can break a `test/**` importer
   *  the primary program never compiles). Passing the primary-only `programTsFiles` there would leave
   *  the sibling's broken importer out of the gate's check scope → a cross-program false-clean. */
  allProgramTsFiles(): readonly RepoRelPath[];
  /** The CURRENT VFS-aware text of `path` (the same content the LS program parses — disk plus any
   *  live overlay), or `undefined` when no loaded program contains it. The read basis a trial-edit
   *  op (`impact_type_error`) splices against, so the spliced overlay and the gate's baseline read
   *  the SAME bytes — a disk read would ignore an uncommitted overlay and make the introduced-error
   *  diff a lie. Generic VFS read: no edit policy here (that stays op-level, §5-L3). */
  fileText(path: RepoRelPath): string | undefined;
  /** Labels of repo tsconfigs codemaster does NOT load as programs — a nested-package config
   *  neither adjacent to the primary nor reached via `references`. Files under such a config are
   *  invisible to `importersOf` / dead-code analysis, so a completeness-claiming op (§3.4 floor)
   *  demotes to a non-`certain`/incomplete verdict and NAMES them, never a silent miss. Empty on
   *  the common repo. Cached once (§19), invalidated when a `tsconfig*.json` lands in reindex. */
  undiscoveredProgramLabels(): readonly string[];
  /** Type-aware "which switch/if-chains DISCRIMINATE on a union T?": the `switch` statements and
   *  `if/else-if` chains whose scrutinee reads a DISCRIMINANT of T — including scrutinees reached via
   *  property access (`switch (spec.type.kind)` where `spec.type: T`), which `find_usages` on T's NAME
   *  structurally misses (the identifier never appears at the switch). Each hit is proof-carrying (the
   *  keyword span + scrutinee + discriminant) with covers/missing vs T's literal domain + a `hasDefault`
   *  flag + honest confidence (a `switch` is `certain`, an `if`-chain / unread case demotes to
   *  `partial`). IDENTITY-gated — a structural supertype (`{ kind: string }`) or unrelated union is
   *  excluded, and a non-discriminant property (`f.value`) is not matched. Bounded: the statements
   *  examined are capped, the cap reported as truncation. A `string` on a target that is not a type. */
  discriminationSites(
    target: TsTargetInput,
    options: DiscriminationSitesOptions,
  ): { view: DiscriminationSitesView; rebind?: HandleRebind } | UnresolvedTarget | string;
  /** READ-PATH completeness lever (`programs:` arg, t-228533): load the named tsconfigs as extra
   *  READ-only programs so a find_usages / importers_of / find_unused_exports call recovers a
   *  complete count over an otherwise-UNDISCOVERED nested config, without editing the repo. The
   *  covered-vs-floored verdict comes from the ONE correct-resolution coverage proof (a partial-
   *  coverage config STAYS floored). Returns the three honest states (loaded / floored / notFound)
   *  for disclosure. */
  loadPrograms(paths: readonly string[]): ProgramsLoadReport;
  /** Which TypeScript drives the LS — reported through status (§5-L1 note). */
  readonly tsVersion: string;
}
