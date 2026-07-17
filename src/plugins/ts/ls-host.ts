// The long-lived LS host (§5-L2) — now MULTI-program (spec Task G). A repo's usages and dead-code
// must be honest across ALL its tsconfigs: a symbol used only from a `test/**` file under
// `tsconfig.test.json` (or a build script, or Vite's app/node split) is NOT dead. So the host
// composes the PRIMARY program (the root tsconfig — the mutation/typecheck target, unchanged for
// every existing consumer via `service`/`configPath`/overlay) with the repo's SIBLING programs,
// discovered once and warmed LAZILY (the cross-program read fan-out builds them on first use;
// memory/cost stay bounded — the heavy thing is the LS, §9). Each program keeps its OWN
// compilerOptions (§9/§19: a flat single-options Program would be a lie).
//
// The single-program engine lives in `./program/single.ts`; discovery in `./program/discover.ts`.
// This file is the composition + the cross-program query surface.

import * as path from 'node:path';
import ts from 'typescript';
import type { RepoRelPath } from '../../core/brands.ts';
import { mintRepoRelPath, toPosix } from '../../support/fs/canonicalize.ts';
import { fnv1a64Hex } from '../../common/hash/fnv.ts';
import type { OverlayEntry } from './vfs/overlay.ts';
import { createSingleProgram, type SingleProgram } from './program/single.ts';
import type { TsProgram } from './program/queryable-program.ts';
import { createIgnoredSet, type IgnoredComputer } from './program/ignored-set.ts';
import {
  discoverSiblingConfigs,
  isTsconfigBasename,
  relLabel,
  repoTsconfigsFrom,
  walkRepoFiles,
  packageConfigLabels,
  type DiscoveredConfig,
} from './program/discover.ts';
import { computeCoverage, type Coverage } from './program/coverage.ts';
import { findSourceFileAcross, pickTypeAuthority } from './program/type-authority.ts';
import {
  createExplicitPrograms,
  type ExplicitPrograms,
  type ProgramsLoadReport,
} from './program/explicit-load.ts';
import { gateAcross, diagnosticsAcross, type GateScope, type GateHostCtx } from './program-gate.ts';
import type { TsDiagnostic } from './diagnostics.ts';

export interface TsProjectHost {
  /** The PRIMARY program's LanguageService — the mutation/typecheck/refactor oracle. */
  readonly service: ts.LanguageService;
  readonly configPath: string | undefined;
  /** A short stable fingerprint of THIS workspace root — stamped into every minted SymbolId so a
   *  handle minted here can be told apart from one minted in a sibling repo (§6 / §4b). */
  readonly rootTag: string;
  /** Primary-program tracked files (absolute posix). */
  fileNames(): readonly string[];
  absOf(rel: RepoRelPath): string;
  relOf(abs: string): RepoRelPath;
  isTracked(rel: RepoRelPath): boolean;
  reindex(changed: readonly RepoRelPath[]): void;
  /** Monotonic aggregate version — bumps whenever ANY program reindexes or the overlay changes,
   *  so a test-only file edit (tracked only by a sibling) still drifts the freshness fingerprint. */
  projectVersion(): number;
  /** §4 rescue LS (patched fork) over the PRIMARY program — for extract refactors the stock LS
   *  asserts on. `undefined` when the fork can't load / its major mismatches. */
  rescueService(): ts.LanguageService | undefined;
  // ── planning overlay (dry-run shadow) — PRIMARY program only ─────────────────────────────────
  // This overlay (a transaction's PlanningOverlay, the dry-run substrate) lives on the primary
  // program ONLY, so confining it here is correct AND cheap. TRAP, NOW PARTLY LIVE: do NOT compose
  // a cross-program query (`programsContaining`/`programs()`-backed find_usages / referenceSpans /
  // unusedExports / importersOf / the rename + change_signature WRITE-site fan-out) while THIS
  // overlay is active — siblings keep reading disk, so the result would mix overlaid-primary with
  // stale-disk sibling state. The cross-program WRITE-site computation honours this via a
  // `crossProgram` flag (off whenever a planning overlay is passed); the move/extract import
  // rewrite stays safe by reading DISK (not a sibling LS), since prior-step edits ride the VFS
  // tree's contentOverride. `gateAcross` below is ORTHOGONAL: it manages its OWN transient,
  // per-program overlays (set→collect→clear), never this primary planning overlay.
  setOverlay(entries: readonly OverlayEntry[], removed?: readonly RepoRelPath[]): void;
  clearOverlay(): void;
  withMergedOverlay<T>(
    entries: readonly OverlayEntry[],
    removed: readonly RepoRelPath[],
    fn: () => T,
  ): T;
  /** ALL loaded programs (primary first); siblings are discovered + built lazily on first call —
   *  this is the cross-program warm point (§9 lazy). Includes any file-driven nested-config
   *  programs already loaded by `ensureProgramFor` (read path). */
  programs(): readonly TsProgram[];
  /** READ-PATH completeness (loose-root monorepo): ensure the NEAREST enclosing tsconfig of
   *  `absPosix` is loaded as a program, so a file whose alias-imports resolve only under a nested
   *  config (the primary globs it WITHOUT that config's `paths`/`baseUrl`) is searched under the
   *  config that actually resolves them. Lazy, idempotent, cached (per-dir nearest-config memo +
   *  loaded-by-config set) — a repeat call never re-walks (§19). No-op when the nearest config is
   *  the primary or an already-discovered sibling. Loaded program joins `programs()` /
   *  `programsContaining` and is subtracted from `undiscoveredProgramLabels()`. Called ONLY from
   *  READ paths (the find_usages family via `findReferencesAcross(loadNearest:true)`, and
   *  `importers_of`); WRITE paths fan out over `builtContaining` and never call this, so a
   *  file-driven program never reaches the mutation/typecheck path and PRIMARY (the edit target) is
   *  never changed (§5-L2 loose-root mutation cousin = separate backlog item). */
  ensureProgramFor(absPosix: string): void;
  /** READ-PATH completeness lever (`programs:` arg, t-228533): load the named tsconfigs as extra
   *  READ-only programs so a query recovers a complete count over an otherwise-UNDISCOVERED nested
   *  config, WITHOUT editing the repo. Each requested config is injected into the SAME
   *  `computeCoverage` discovered set, so its covered-vs-floored verdict (and member-stray injection)
   *  comes from the ONE correct-resolution proof — a partial-coverage config STAYS floored, never a
   *  false lift. Kept OUT of `built()`/`builtContaining` so a read-time load never perturbs a later
   *  mutation's edit-set (§5-L2). Idempotent, bounded (no repo walk), persisted for the warm session
   *  (cleared on a structural tsconfig reindex). Returns the three honest states for disclosure. */
  loadPrograms(paths: readonly string[]): ProgramsLoadReport;
  /** §2.8 write gate, fanned across every program the edit touches (Task G for WRITES): the
   *  overlay typecheck on EACH affected program + the disk baseline over the same set, so a
   *  sibling-program dangle is caught. Builds the sibling programs (a write must verify them). */
  gateAcross(
    files: readonly { path: RepoRelPath; content: string }[],
    scope: GateScope,
  ): { baseline: TsDiagnostic[]; overlay: TsDiagnostic[]; programs: string[]; degraded: string[] };
  /** Disk diagnostics across every affected program — the post-apply half of the fan-out gate.
   *  `restrictTo` pins the program set to the pre-apply baseline's (the `gateAcross` `programs`). */
  diagnosticsAcross(scope: GateScope, restrictTo?: readonly string[]): TsDiagnostic[];
  /** READ-context fan-out set for a decl: the built programs (primary + siblings) PLUS any
   *  file-driven nested program already loaded, filtered to those containing `absPosix`. Run
   *  findReferences only where the declaration file actually lives. */
  programsContaining(absPosix: string): readonly TsProgram[];
  /** WRITE-context fan-out set: the BUILT programs only (primary + siblings), NEVER the file-driven
   *  read-path programs — so a mutation's edit-site computation is session-order-INDEPENDENT and
   *  stays consistent with the §2.8 typecheck gate (which runs over `built()`). This is exactly the
   *  pre-file-driven behavior; rename / change_signature use it, so file-driven programs can never
   *  introduce an un-gated, read-history-dependent edit. */
  builtContaining(absPosix: string): readonly TsProgram[];
  /** The first program (primary preferred) whose built program contains `absPosix`, with its
   *  source file — the cross-program resolution lookup (a test-declared symbol resolves too). */
  sourceFileAcross(absPosix: string): { sf: ts.SourceFile; program: TsProgram } | undefined;
  /** The program whose checker answers a TYPE query for `absPosix` — the seam every type-PRODUCING
   *  read routes through (expand_type, construction_sites, discrimination_sites, firstParamTypeMembers,
   *  wideningSinksAt). Normally primary-first. But a no-config FALLBACK primary globs the WHOLE repo
   *  under DEFAULT options, so its type-space wrongly absorbs a whole-repo `declare global`/`declare
   *  module` augmentation stray → a MEMBER src symbol's type reads polluted (t-593802, never-lie §3);
   *  there it routes to the DEEPEST-ENCLOSING real-config owner (member options resolve the file's
   *  aliases + exclude the strays). The choice is a PURE function of `nearestConfig` over the
   *  deterministic BUILT set (NOT the session-dependent file-driven/explicit programs) → cold==warm
   *  (§16). Falls back to the primary-first lookup when no real-config program owns the file. NOT used
   *  by the §2.8 planning-overlay type read (overlay-type.ts) — that stays on the primary by design. */
  typeAuthorityFor(absPosix: string): TsProgram;
  /** Labels of every program codemaster will load for this repo (primary first), via cheap
   *  discovery WITHOUT building the sibling LS objects — for status self-describe. */
  programLabels(): readonly string[];
  /** Labels of repo tsconfigs codemaster does NOT load as programs — a nested-package config
   *  neither adjacent to the primary nor reached via `references` (the discovery sources). Such a
   *  program's files could reference an export every LOADED program reads as dead, so
   *  `find_unused_exports` demotes its otherwise-`certain` verdicts to `partial` against this set
   *  (never a silent false-dead, §3.4). Empty on the common repo (all tsconfigs adjacent/
   *  referenced). Cached once — never per query (§19); the memo is invalidated by `reindex` when a
   *  `tsconfig*.json` lands in the changed set, so a config ADDED post-warm IS picked up (no
   *  reconnect needed) without a per-reindex re-walk. */
  undiscoveredProgramLabels(): readonly string[];
  /** Labels of nested PACKAGE configs (a dir carrying its own `package.json`) codemaster loads as
   *  independent programs — the candidate roots for the `list` inactive-registry disclosure (§3.6): a
   *  framework plugin autodetects off a package.json, so only such a dir can own a registry as its own
   *  `root:<dir>`. Computed on demand (bounded: a per-tsconfig `package.json` probe over the cached
   *  list, only when the rare inactive-registry hint fires — never a repo-scale per-query walk, §19). */
  nestedPackageLabels(): readonly string[];
  dispose(): void;
}

export function createTsProjectHost(
  root: string,
  tsconfigOverride?: string,
  deps?: { computeIgnored?: IgnoredComputer },
): TsProjectHost {
  // One DocumentRegistry shared across every stock-TS program: files common to two configs
  // (src/** in both the app and the test config) parse once. The §4 rescue fork keeps its own
  // registry inside each SingleProgram — the two TS namespaces must never cross-feed.
  const registry = ts.createDocumentRegistry();
  const configPath = resolveConfigPath(root, tsconfigOverride);

  // The `.gitignore`-aware junk set (t-019044) — computed once per structural reindex, shared by
  // every program's `loadFileList` (cleared in `reindex`). Its memoization lives in ./program/ignored-set.
  const ignoredSet = createIgnoredSet(root, deps?.computeIgnored);
  const ignored = ignoredSet.get;

  const primary = createSingleProgram(
    root,
    configPath,
    primaryLabel(root, configPath),
    registry,
    ignored,
  );

  // Sibling discovery runs ONCE and is cached (config paths + labels) — never per query (§19
  // hang). Building the sibling LS objects (parse tsconfig + glob files) is the heavier, separate
  // lazy step deferred to the first cross-program read.
  // ONE repo walk (`walkRepoFiles`, all source files) per host lifetime, the §19-bounded part shared
  // by THREE consumers: the tsconfig scan (`repoTsconfigsFrom` filters it → the undiscovered base +
  // source-2 workspace-member discovery) AND member coverage + stray injection (`computeCoverage`). So
  // there is a single repo walk per host, never one per consumer — invalidated with the tsconfig
  // memos on a structural tsconfig/workspace-manifest change (the reindex block below).
  let repoFiles: string[] | undefined;
  const repoFilesList = (): string[] => (repoFiles ??= walkRepoFiles(root));
  let repoTsconfigs: string[] | undefined;
  const repoTsconfigsList = (): string[] =>
    (repoTsconfigs ??= repoTsconfigsFrom(repoFilesList(), root));

  let discovered: DiscoveredConfig[] | undefined;
  const discover = (): DiscoveredConfig[] =>
    (discovered ??= discoverSiblingConfigs(root, configPath, repoTsconfigsList()));

  // The coverage proof (correct-resolution union → floor-subtraction set + per-member stray injection
  // sets, t-232769). Memoized once per structural reindex (invalidated with the tsconfig memos below).
  // The primary's file-set is counted ONLY when it has a real config — the no-config FALLBACK glob is
  // passed as [] so a fallback-only file never counts as coverage (the correct-resolution guard).
  let coverageMemo: Coverage | undefined;
  const coverage = (): Coverage =>
    (coverageMemo ??= computeCoverage(
      root,
      configPath !== undefined ? primary.fileNames() : [],
      // Discovery ∪ the `programs:`-requested configs, so an explicit config's files enter the
      // correct-resolution union and its subtraction verdict falls out of the SAME machinery.
      explicit.discoveredForCoverage(),
      repoTsconfigsList(),
      repoFilesList(),
      ignored(),
      configPath,
    ));

  // Repo tsconfigs found on disk MINUS the loaded set (primary + the adjacent/`references`
  // siblings `discover()` returns) — the UNDISCOVERED programs. Cached once (the repo walk is the
  // §19-bounded part); both sides are `toPosix`-canonical so the primary/siblings exclude cleanly
  // (a spelling mismatch would leave the primary in the set → universal false demotion).
  // The base undiscovered set is the cached repo walk (the §19-bounded part) MINUS the statically
  // loaded configs (primary + siblings) — stored as posix ABS PATHS so the dynamic file-driven
  // subtraction below (which keys by config path) is exact. Labels are derived at call time.
  let undiscoveredBase: string[] | undefined;
  // The final labels are memoized too (not just the repo walk), so `undiscoveredProgramLabels()`
  // returns a STABLE reference across a non-tsconfig reindex (the §19 no-re-walk guarantee, asserted
  // by ls-host-tsconfig-invalidation.test). Invalidated whenever the base recomputes (a tsconfig
  // change) OR `fileDriven` changes (fix-A loaded a config) — both below.
  let undiscoveredMemo: string[] | undefined;
  const undiscoveredLabels = (): readonly string[] => {
    if (undiscoveredMemo === undefined) {
      if (undiscoveredBase === undefined) {
        // Subtract a config from the floor via the CORRECT-RESOLUTION coverage proof (`computeCoverage`,
        // SYNTACTIC — no LS build, keeps siblings lazy §9): any tsconfig whose entire glob ⊆ the union
        // of REAL-config programs' file-sets + injected member strays (a redundant base/extends config
        // like `tsconfig.base.json`, or a member whose src + injected strays cover its whole dir). The
        // no-config fallback glob is EXCLUDED from that union, so a fallback-only file (aliases never
        // resolved) never subtracts its config — kept floored (complete:false), the §3.4 honest→lying
        // direction closed on ANY repo, not by claude-ui coincidence.
        const loaded = new Set(coverage().safe);
        if (configPath !== undefined) loaded.add(toPosix(configPath)); // the primary is always built
        undiscoveredBase = repoTsconfigsList().filter((abs) => !loaded.has(abs));
      }
      // Subtract the file-driven nested-config programs we DID load (§5-L2 read-path completeness):
      // a config a read loaded IS searched, so reporting it undiscovered would over-demote (a false
      // LOWER-BOUND on an answer we can prove complete). Cheap filter; the repo walk stays cached.
      // EXCEPTION — a config the agent NAMED via `programs:` is decided by the CORRECT-RESOLUTION
      // coverage proof above (in `loaded`/`safe` or not), NEVER lifted by this looser file-driven
      // membership: the two paths can otherwise disagree on ONE config (a `programs:`-named config
      // that is ALSO the target's nearest config loads into both maps; a malformed/empty-glob one is
      // floored by coverage yet `fileDriven.has` would subtract it — a self-contradictory floor
      // verdict, the never-lie violation). So keep an explicitly-named config floored here whenever
      // coverage did not subtract it — the `programs:` disclosure (`programsFloored`) then agrees.
      const explicitConfigs = explicit.configs();
      undiscoveredMemo = undiscoveredBase
        .filter((abs) => !fileDriven.has(abs) || explicitConfigs.has(abs))
        .map((abs) => relLabel(root, abs));
    }
    return undiscoveredMemo;
  };

  // ── file-driven nearest-config discovery (read-path completeness) ──────────────────────────────
  // A loose-root monorepo's PRIMARY config (the root tsconfig) may glob a nested package's files
  // WITHOUT that package's `paths`/`baseUrl` alias, so the primary program can't resolve the
  // alias-imports and a read anchored there finds ZERO references — a false-`certain`-dead (the
  // fatal lie). The nested package's OWN tsconfig resolves the alias. So when a READ targets a file
  // whose nearest enclosing tsconfig is neither the primary nor an already-discovered sibling, load
  // THAT config lazily as an extra read-only program; the existing cross-program fan-out then
  // merges + dedups its references (the broken primary view is absorbed, no double-count). PRIMARY
  // is unchanged — only read paths call `ensureProgramFor`, so the mutation/typecheck target never
  // grows (the loose-root MUTATION cousin is a separate backlog item).
  const fileDriven = new Map<string, SingleProgram>(); // config posix path → its program
  const dirConfig = new Map<string, string | undefined>(); // file dir → nearest enclosing config (memo)

  const nearestConfig = (absPosix: string): string | undefined => {
    const dir = path.posix.dirname(absPosix);
    if (dirConfig.has(dir)) return dirConfig.get(dir);
    const found = ts.findConfigFile(dir, ts.sys.fileExists, 'tsconfig.json');
    const config = found !== undefined ? toPosix(found) : undefined;
    dirConfig.set(dir, config);
    return config;
  };
  const ensureProgramFor = (absPosix: string): void => {
    const config = nearestConfig(toPosix(absPosix));
    if (config === undefined) return;
    if (configPath !== undefined && config === toPosix(configPath)) return; // the primary itself
    if (fileDriven.has(config)) return; // already loaded
    if (discover().some((c) => toPosix(c.path) === config)) return; // an already-discovered sibling
    if (explicit.configs().has(config)) return; // already loaded as a `programs:` explicit program
    fileDriven.set(
      config,
      createSingleProgram(root, config, relLabel(root, config), registry, ignored),
    );
    undiscoveredMemo = undefined; // the loaded config drops out of the undiscovered set
  };

  // The `programs:` per-call lever (t-228533) — its whole state + logic lives in `./program/explicit-load`
  // so this file stays thin. The requested configs are injected into the SAME `computeCoverage`
  // discovered set (correct-resolution verdict, no second gate) and built as READ-only extra programs
  // for the search fan-out — deliberately OUT of `built()`/`builtContaining` (session-order-independent
  // writes, §5-L2). Created here (after the coverage/floor memo closures it wires into, which reference
  // it back only inside their bodies — resolved by first-call time). `buildProgram` mints a read-only
  // program with the member strays coverage computed (t-232769 correct-resolution); `invalidateCoverage`
  // drops the coverage + floor memos so a newly-injected config re-proves them.
  const explicit: ExplicitPrograms = createExplicitPrograms({
    root,
    configPath,
    discover,
    coverage,
    invalidateCoverage: () => {
      coverageMemo = undefined;
      undiscoveredBase = undefined;
      undiscoveredMemo = undefined;
    },
    buildProgram: (config, strays) =>
      createSingleProgram(root, config, relLabel(root, config), registry, ignored, strays),
  });
  const explicitPrograms = (): readonly SingleProgram[] => explicit.programs();

  let siblings: SingleProgram[] | undefined;
  const built = (): readonly SingleProgram[] => {
    if (siblings === undefined) {
      // Inject each workspace member's git-tracked strays into ITS program (t-232769) so they compile
      // under the member's own compilerOptions → correct alias resolution. A non-member sibling gets [].
      const strays = coverage().memberStrays;
      siblings = discover().map((c) =>
        createSingleProgram(
          root,
          c.path,
          c.label,
          registry,
          ignored,
          strays.get(toPosix(c.path)) ?? [],
        ),
      );
    }
    return [primary, ...siblings];
  };
  /** Already-built programs — what reindex/dispose touch WITHOUT forcing sibling discovery (a
   *  reindex before any cross-program query must stay primary-only-cheap; unbuilt siblings read
   *  fresh from disk when first warmed). */
  const builtSoFar = (): readonly SingleProgram[] =>
    siblings === undefined ? [primary] : [primary, ...siblings];

  // Host-level monotonic version — the freshness fingerprint + literalCalls memo key. Bumped on
  // every mutating host call so any program's drift (incl. a sibling-only test file) is observed.
  let hostVersion = 1;

  const rootTag = fnv1a64Hex(toPosix(root)).slice(0, 8);

  // An agent addresses a file by REPO-RELATIVE path (`src/x.ts`) or an ABSOLUTE one (a
  // grep/editor paste, `/repo/src/x.ts`). A relative path joins onto the canonical root; an
  // absolute one must NOT be re-joined (`path.join(root, abs)` double-joins into a nonexistent
  // path → a false "file not in the TS project"). Funnel the absolute case through the §19
  // minting chokepoint (`mintRepoRelPath`: realpath + case-fold + symlink/pnpm policy, `root`
  // being the canonical root from `canonicalizeRoot`) so it brands to the SAME repo-relative key
  // a relative spelling of the same file reaches — then join that. An absolute path resolving
  // OUTSIDE the root can't be a repo file: pass it through normalized so the caller's
  // `sourceFileAcross` misses and fails honestly ("file not in the TS project"), never guessed.
  const absOf = (rel: RepoRelPath): string => {
    if (!path.isAbsolute(rel)) return path.join(root, rel);
    const minted = mintRepoRelPath(root, rel);
    return minted.ok ? path.join(root, minted.path) : path.normalize(rel);
  };
  const relOf = (abs: string): RepoRelPath => {
    const posix = toPosix(abs);
    const prefix = `${toPosix(root)}/`;
    return (posix.startsWith(prefix) ? posix.slice(prefix.length) : posix) as RepoRelPath;
  };
  // The fan-out gate context — `built()` materializes the siblings (a write must verify them).
  const gateCtx = (): GateHostCtx => ({ primary, programs: built(), relOf, absOf });

  // Shared by the `sourceFileAcross` method and `typeAuthorityFor`; the `extras` thunk keeps siblings
  // lazy for a primary-resident target (§5-L2).
  const sourceFileAcrossLocal = (absPosix: string) =>
    findSourceFileAcross(absPosix, primary, () => [...built(), ...explicitPrograms()]);

  return {
    service: primary.service,
    configPath,
    rootTag,
    fileNames: () => primary.fileNames(),
    absOf,
    relOf,
    isTracked: (rel) => primary.isTracked(toPosix(path.join(root, rel))),
    reindex(changed) {
      // Drop the memoized `.gitignore` junk set so the NEXT structural `loadFileList` recomputes it
      // exactly once (a new/removed file or an edited `.gitignore` may change what git ignores). A
      // NON-structural reindex clears it but triggers no `loadFileList`, so no git call fires until
      // the next structural re-glob — the once-per-structural-reindex cadence the test asserts (§19).
      ignoredSet.clear();
      // A tsconfig add/remove/edit in the changed set may change the discovered-sibling SET and the
      // undiscovered SET — both host-lifetime memos that §3.5 content-fingerprint freshness can NOT
      // see (it fingerprints file CONTENT, not the tsconfig set). Left stale, a `git checkout` that
      // ADDS a nested tsconfig importing a `src` export would read that export `certain`-DEAD until
      // an MCP reconnect (a silent false-dead). So invalidate the memos here — but ONLY on a cheap
      // basename scan of the (small) changed set, NEVER a repo re-walk per reindex (the §19 ls-host
      // per-call-tree-scan hang class). The actual re-walk (walkRepoFiles) then happens LAZILY on the
      // next undiscoveredProgramLabels()/discover() call — i.e. only when a tsconfig changed. The
      // shared `repoFiles` walk also feeds member coverage + stray injection (`computeCoverage`); it is
      // dropped here at the same structural cadence. Beyond a tsconfig change, a NEW git-tracked TS file
      // UNDER A MEMBER DIR may add a stray the member must inject (the stray set is source-derived, not
      // tsconfig-derived) — else a warm daemon MISSES that usage AND reports `complete` (a §3.4/§3.5
      // lie, not mere over-floor). So also refresh on `addsMemberStray`: a changed TS path under a
      // member dir NOT yet tracked by any built program (a genuine add, not an edit — an edit stays
      // cheap). Bounded: changed × members × built-programs, only when coverage already ran (a memo to
      // refresh); member dirs come from the CACHED tsconfig list (no new walk).
      const addsMemberStray = (): boolean => {
        if (coverageMemo === undefined || repoTsconfigs === undefined) return false;
        const memberDirs = packageConfigLabels(root, repoTsconfigs, configPath).map((l) =>
          path.posix.dirname(l),
        );
        if (memberDirs.length === 0) return false;
        const built = builtSoFar();
        return changed.some((rel) => {
          if (!/\.(ts|tsx|cts|mts)$/.test(rel)) return false;
          const posix = toPosix(rel);
          if (!memberDirs.some((d) => posix === d || posix.startsWith(`${d}/`))) return false;
          const abs = toPosix(path.join(root, rel));
          return built.every((program) => !program.isTracked(abs)); // untracked → a genuine ADD
        });
      };
      if (changed.some(isStructuralConfigChange) || addsMemberStray()) {
        repoFiles = undefined;
        repoTsconfigs = undefined;
        discovered = undefined;
        coverageMemo = undefined;
        undiscoveredBase = undefined;
        undiscoveredMemo = undefined;
        // Dispose already-built siblings before dropping them: the set they were built from may no
        // longer match discover(), and an undisposed sibling LS would leak. They rebuild lazily
        // from the current tree on the next cross-program read.
        if (siblings !== undefined) {
          for (const sibling of siblings) sibling.dispose();
          siblings = undefined;
        }
        // A tsconfig add/remove also invalidates the file-driven nearest-config memo + its loaded
        // programs (a config moved/deleted, or a now-discoverable sibling): drop them so the next
        // read re-resolves the nearest config against the current tree.
        dirConfig.clear();
        for (const program of fileDriven.values()) program.dispose();
        fileDriven.clear();
        // The `programs:`-loaded explicit programs are keyed by config path too — a tsconfig
        // add/remove/edit may move/delete one or change its glob. Drop them (the agent re-passes
        // `programs:` on the next call if still wanted); coverage/floor already recompute above.
        explicit.clear();
      }
      // Propagate to every BUILT program (each decides structural-ness against its OWN glob — a
      // new test file is structural for the test program, not the primary). Unbuilt siblings are
      // untouched; they read the current tree when first warmed. File-driven programs reindex too,
      // so a loaded nested program stays fresh (cold == warm across the read-path-loaded state).
      for (const program of builtSoFar()) program.reindex(changed);
      for (const program of fileDriven.values()) program.reindex(changed);
      explicit.reindex(changed);
      hostVersion++;
    },
    projectVersion: () => hostVersion,
    rescueService: () => primary.rescueService(),
    setOverlay(entries, removed) {
      primary.setOverlay(entries, removed);
      hostVersion++;
    },
    clearOverlay() {
      primary.clearOverlay();
      hostVersion++;
    },
    withMergedOverlay(entries, removed, fn) {
      hostVersion++;
      return primary.withMergedOverlay(entries, removed, () => {
        try {
          return fn();
        } finally {
          hostVersion++;
        }
      });
    },
    programs: () => [...built(), ...fileDriven.values(), ...explicitPrograms()],
    ensureProgramFor,
    loadPrograms: (paths) => explicit.load(paths),
    gateAcross: (files, scope) => gateAcross(gateCtx(), files, scope),
    diagnosticsAcross: (scope, restrictTo) => diagnosticsAcross(gateCtx(), scope, restrictTo),
    programsContaining(absPosix) {
      // Read-path fan-out: the built programs (primary + siblings) PLUS any file-driven nested
      // program AND any `programs:`-loaded explicit program that contains this file. WRITE paths use
      // `builtContaining` instead, so neither a file-driven nor an explicit program ever enters the
      // mutation/typecheck path (session-order-independent writes, §5-L2).
      return [...built(), ...fileDriven.values(), ...explicitPrograms()].filter((p) =>
        p.containsFile(absPosix),
      );
    },
    builtContaining(absPosix) {
      return built().filter((p) => p.containsFile(absPosix));
    },
    sourceFileAcross: sourceFileAcrossLocal,
    typeAuthorityFor: (absPosix) =>
      pickTypeAuthority(toPosix(absPosix), {
        configPath,
        primary,
        built,
        nearestConfig,
        primaryFirst: (posix) => sourceFileAcrossLocal(posix)?.program,
      }),
    programLabels: () => [primary.label, ...discover().map((c) => c.label)],
    undiscoveredProgramLabels: () => undiscoveredLabels(),
    nestedPackageLabels: () => packageConfigLabels(root, repoTsconfigsList(), configPath),
    dispose() {
      for (const program of builtSoFar()) program.dispose();
      for (const program of fileDriven.values()) program.dispose();
      explicit.clear();
    },
  };
}

/** Does a reindex changed path point at a tsconfig (add/remove/edit)? `RepoRelPath` is posix, so a
 *  trailing-segment basename is all we need — the shared predicate keeps this in lockstep with
 *  sibling discovery and the undiscovered scan. */
/** A change that may alter the discovered/undiscovered PROGRAM set (not just a file's content): a
 *  `tsconfig*.json` add/remove/edit, OR a `pnpm-workspace.yaml` edit (re-globbing existing member
 *  configs — an add-a-package normally also adds its `tsconfig.json`, which the tsconfig arm already
 *  catches). `package.json` is deliberately NOT here: it churns on every install. The consequence:
 *  editing a `package.json` `workspaces` glob while the member's `tsconfig.json` ALREADY exists on
 *  disk (no tsconfig add to trip the tsconfig arm) is not re-discovered until the next tsconfig
 *  change / respawn — a bounded, provably CONSERVATIVE staleness (the stale set is the old, SMALLER
 *  discovered set → a LARGER undiscovered set → more floored, never a false `certain`-dead). */
function isStructuralConfigChange(rel: RepoRelPath): boolean {
  const base = rel.slice(rel.lastIndexOf('/') + 1);
  return isTsconfigBasename(base) || base === 'pnpm-workspace.yaml';
}

function resolveConfigPath(root: string, override?: string): string | undefined {
  if (override !== undefined) return path.join(root, override);
  return ts.findConfigFile(root, ts.sys.fileExists, 'tsconfig.json');
}

function primaryLabel(root: string, configPath: string | undefined): string {
  if (configPath === undefined) return '(no tsconfig)';
  const rel = path.relative(root, configPath);
  return rel.startsWith('..') || path.isAbsolute(rel) ? toPosix(configPath) : toPosix(rel);
}
