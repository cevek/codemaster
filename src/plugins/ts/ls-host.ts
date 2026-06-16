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
import { discoverSiblingConfigs, type DiscoveredConfig } from './program/discover.ts';

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
  // ── overlay (dry-run shadow) — PRIMARY program only ──────────────────────────────────────────
  // Mutating ops (rename/move/extract/codemod/typecheck gates) overlay + query only the primary,
  // so confining the overlay there is correct AND keeps it cheap. TRAP for a future op: do NOT
  // compose a cross-program READ (`programsContaining`/`programs()`-backed find_usages /
  // referenceSpans / unusedExports / importersOf) INSIDE an active overlay scope — siblings keep
  // reading disk, so the result would mix overlaid-primary with stale-disk sibling refs. Today no
  // overlay-bearing op fans out, so this stays a guard rail, not a live bug.
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
  /** Programs whose built program currently contains `absPosix` — the fan-out set for a decl: run
   *  findReferences only where the declaration file actually lives. */
  programsContaining(absPosix: string): readonly TsProgram[];
  /** The first program (primary preferred) whose built program contains `absPosix`, with its
   *  source file — the cross-program resolution lookup (a test-declared symbol resolves too). */
  sourceFileAcross(absPosix: string): { sf: ts.SourceFile; program: TsProgram } | undefined;
  /** Labels of every program codemaster will load for this repo (primary first), via cheap
   *  discovery WITHOUT building the sibling LS objects — for status self-describe. */
  programLabels(): readonly string[];
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

  return {
    service: primary.service,
    configPath,
    rootTag,
    fileNames: () => primary.fileNames(),
    absOf: (rel) => path.join(root, rel),
    relOf: (abs) => {
      const posix = toPosix(abs);
      const prefix = `${toPosix(root)}/`;
      return (posix.startsWith(prefix) ? posix.slice(prefix.length) : posix) as RepoRelPath;
    },
    isTracked: (rel) => primary.isTracked(toPosix(path.join(root, rel))),
    reindex(changed) {
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
    dispose() {
      for (const program of builtSoFar()) program.dispose();
    },
  };
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
