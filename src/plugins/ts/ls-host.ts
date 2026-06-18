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
import { toPosix } from '../../support/fs/canonicalize.ts';
import { fnv1a64Hex } from '../../common/hash/fnv.ts';
import type { OverlayEntry } from './vfs/overlay.ts';
import { createSingleProgram, type SingleProgram } from './program/single.ts';
import {
  discoverSiblingConfigs,
  findRepoTsconfigs,
  isTsconfigBasename,
  relLabel,
  type DiscoveredConfig,
} from './program/discover.ts';
import { gateAcross, diagnosticsAcross, type GateScope, type GateHostCtx } from './program-gate.ts';
import type { TsDiagnostic } from './diagnostics.ts';

/** One queryable program exposed to the cross-program fan-out — the primary or a sibling. */
interface TsProgram {
  readonly service: ts.LanguageService;
  /** Provenance label (`tsconfig.json` / `tsconfig.test.json`) for status + cross-program origin. */
  readonly label: string;
  getProgram(): ts.Program | undefined;
  /** Is `absPosix` a source file in this built program right now? */
  containsFile(absPosix: string): boolean;
}

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
   *  this is the cross-program warm point (§9 lazy). */
  programs(): readonly TsProgram[];
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
  /** Programs whose built program currently contains `absPosix` — the fan-out set for a decl: run
   *  findReferences only where the declaration file actually lives. */
  programsContaining(absPosix: string): readonly TsProgram[];
  /** The first program (primary preferred) whose built program contains `absPosix`, with its
   *  source file — the cross-program resolution lookup (a test-declared symbol resolves too). */
  sourceFileAcross(absPosix: string): { sf: ts.SourceFile; program: TsProgram } | undefined;
  /** Labels of every program codemaster will load for this repo (primary first), via cheap
   *  discovery WITHOUT building the sibling LS objects — for status self-describe. */
  programLabels(): readonly string[];
  /** Labels of repo tsconfigs codemaster does NOT load as programs — a nested-package config
   *  neither adjacent to the primary nor reached via `references` (the discovery sources). Such a
   *  program's files could reference an export every LOADED program reads as dead, so
   *  `find_unused_exports` demotes its otherwise-`certain` verdicts to `partial` against this set
   *  (never a silent false-dead, §3.4). Empty on the common repo (all tsconfigs adjacent/
   *  referenced). Cached once — never per query (§19). Like `discover()`, a config ADDED post-warm
   *  is not picked up (consistent with sibling discovery; reconnect to re-scan). */
  undiscoveredProgramLabels(): readonly string[];
  dispose(): void;
}

export function createTsProjectHost(root: string, tsconfigOverride?: string): TsProjectHost {
  // One DocumentRegistry shared across every stock-TS program: files common to two configs
  // (src/** in both the app and the test config) parse once. The §4 rescue fork keeps its own
  // registry inside each SingleProgram — the two TS namespaces must never cross-feed.
  const registry = ts.createDocumentRegistry();
  const configPath = resolveConfigPath(root, tsconfigOverride);
  const primary = createSingleProgram(root, configPath, primaryLabel(root, configPath), registry);

  // Sibling discovery runs ONCE and is cached (config paths + labels) — never per query (§19
  // hang). Building the sibling LS objects (parse tsconfig + glob files) is the heavier, separate
  // lazy step deferred to the first cross-program read.
  let discovered: DiscoveredConfig[] | undefined;
  const discover = (): DiscoveredConfig[] =>
    (discovered ??= discoverSiblingConfigs(root, configPath));

  // Repo tsconfigs found on disk MINUS the loaded set (primary + the adjacent/`references`
  // siblings `discover()` returns) — the UNDISCOVERED programs. Cached once (the repo walk is the
  // §19-bounded part); both sides are `toPosix`-canonical so the primary/siblings exclude cleanly
  // (a spelling mismatch would leave the primary in the set → universal false demotion).
  let undiscovered: string[] | undefined;
  const undiscoveredLabels = (): readonly string[] => {
    if (undiscovered === undefined) {
      const loaded = new Set<string>();
      if (configPath !== undefined) loaded.add(toPosix(configPath));
      for (const c of discover()) loaded.add(toPosix(c.path));
      undiscovered = findRepoTsconfigs(root)
        .filter((abs) => !loaded.has(abs))
        .map((abs) => relLabel(root, abs));
    }
    return undiscovered;
  };

  let siblings: SingleProgram[] | undefined;
  const built = (): readonly SingleProgram[] => {
    if (siblings === undefined) {
      siblings = discover().map((c) => createSingleProgram(root, c.path, c.label, registry));
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

  const absOf = (rel: RepoRelPath): string => path.join(root, rel);
  const relOf = (abs: string): RepoRelPath => {
    const posix = toPosix(abs);
    const prefix = `${toPosix(root)}/`;
    return (posix.startsWith(prefix) ? posix.slice(prefix.length) : posix) as RepoRelPath;
  };
  // The fan-out gate context — `built()` materializes the siblings (a write must verify them).
  const gateCtx = (): GateHostCtx => ({ primary, programs: built(), relOf, absOf });

  return {
    service: primary.service,
    configPath,
    rootTag,
    fileNames: () => primary.fileNames(),
    absOf,
    relOf,
    isTracked: (rel) => primary.isTracked(toPosix(path.join(root, rel))),
    reindex(changed) {
      // A tsconfig add/remove/edit in the changed set may change the discovered-sibling SET and the
      // undiscovered SET — both host-lifetime memos that §3.5 content-fingerprint freshness can NOT
      // see (it fingerprints file CONTENT, not the tsconfig set). Left stale, a `git checkout` that
      // ADDS a nested tsconfig importing a `src` export would read that export `certain`-DEAD until
      // an MCP reconnect (a silent false-dead). So invalidate the memos here — but ONLY on a cheap
      // basename scan of the (small) changed set, NEVER a repo re-walk per reindex (the §19 ls-host
      // per-call-tree-scan hang class). The actual re-walk (findRepoTsconfigs) then happens LAZILY
      // on the next undiscoveredProgramLabels()/discover() call — i.e. only when a tsconfig changed.
      if (changed.some(isTsconfigChange)) {
        discovered = undefined;
        undiscovered = undefined;
        // Dispose already-built siblings before dropping them: the set they were built from may no
        // longer match discover(), and an undisposed sibling LS would leak. They rebuild lazily
        // from the current tree on the next cross-program read.
        if (siblings !== undefined) {
          for (const sibling of siblings) sibling.dispose();
          siblings = undefined;
        }
      }
      // Propagate to every BUILT program (each decides structural-ness against its OWN glob — a
      // new test file is structural for the test program, not the primary). Unbuilt siblings are
      // untouched; they read the current tree when first warmed.
      for (const program of builtSoFar()) program.reindex(changed);
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
    programs: () => built(),
    gateAcross: (files, scope) => gateAcross(gateCtx(), files, scope),
    diagnosticsAcross: (scope, restrictTo) => diagnosticsAcross(gateCtx(), scope, restrictTo),
    programsContaining(absPosix) {
      return built().filter((p) => p.containsFile(absPosix));
    },
    sourceFileAcross(absPosix) {
      // Primary FIRST, and short-circuit before `built()` forces sibling construction — a
      // primary-resident target (find_definition / expand_type / rename) must not eagerly glob
      // every sibling tsconfig (§5-L2 "siblings warm lazily on the first cross-program read").
      const primarySf = primary.getProgram()?.getSourceFile(absPosix);
      if (primarySf !== undefined) return { sf: primarySf, program: primary };
      for (const program of built()) {
        if (program === primary) continue;
        const sf = program.getProgram()?.getSourceFile(absPosix);
        if (sf !== undefined) return { sf, program };
      }
      return undefined;
    },
    programLabels: () => [primary.label, ...discover().map((c) => c.label)],
    undiscoveredProgramLabels: () => undiscoveredLabels(),
    dispose() {
      for (const program of builtSoFar()) program.dispose();
    },
  };
}

/** Does a reindex changed path point at a tsconfig (add/remove/edit)? `RepoRelPath` is posix, so a
 *  trailing-segment basename is all we need — the shared predicate keeps this in lockstep with
 *  sibling discovery and the undiscovered scan. */
function isTsconfigChange(rel: RepoRelPath): boolean {
  return isTsconfigBasename(rel.slice(rel.lastIndexOf('/') + 1));
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
