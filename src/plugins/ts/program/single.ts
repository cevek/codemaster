// ONE LanguageService over ONE tsconfig — the unit the multi-program host (`../ls-host.ts`)
// composes (§9 "one Program per package tsconfig, each keeping its own compilerOptions" — a flat
// single-options Program would be a lie). Owns this program's file list (versioned, disk-backed),
// its overlay (dry-run shadow), and its own monotonic version. Lazy: building the LS object parses
// the tsconfig + globs the file list once; the program's types compute only when a query runs.
//
// The tsconfig parse is cached and re-run ONLY on a structural reindex (a re-glob IS the intent
// then) — a structural change being either a new/renamed source file OR a `tsconfig*.json` edit in
// the changed set (a widened `include` changes this program's file set; an edited `strict`/`paths`/…
// changes its compilerOptions — both stale until `loadFileList` re-parses, the §3.5 staleness lie if
// dropped). It is NEVER re-run on the LS hot path (`getCompilationSettings` is called every
// synchronize pass; a per-call re-parse recursively directory-scans the whole tree → an unbounded
// HANG, the backoffice2 incident; see ls-host-config-cache.test.ts).

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import * as path from 'node:path';
import ts from 'typescript';
import type { RepoRelPath } from '../../../core/brands.ts';
import { toPosix } from '../../../support/fs/canonicalize.ts';
import { hasIgnoredDirSegment } from '../../../support/fs/ignored-paths.ts';
import { Overlay, type OverlayEntry } from '../vfs/overlay.ts';
import { buildMembership } from './membership.ts';
import { isTsconfigBasename } from './discover.ts';

/** One queryable TS program (an LS over a single tsconfig) plus the bookkeeping the host needs
 *  to keep it fresh. Public methods only; the LS host internals stay private. */
export interface SingleProgram {
  /** The live LanguageService — the §3.1 oracle for this program. */
  readonly service: ts.LanguageService;
  /** The tsconfig this program compiles (absolute), or `undefined` for the no-config fallback. */
  readonly configPath: string | undefined;
  /** Short provenance label, e.g. `tsconfig.json` / `tsconfig.test.json` — surfaced in status so
   *  an agent knows which sibling program a cross-program usage came from. */
  readonly label: string;
  getProgram(): ts.Program | undefined;
  /** Every tracked file (absolute posix). */
  fileNames(): readonly string[];
  /** Is `absPosix` part of this program's tracked file set (config glob)? */
  isTracked(absPosix: string): boolean;
  /** Is `absPosix` a source file in the BUILT program right now (drives the cross-program
   *  fan-out: only run findReferences on programs that actually contain the decl file)? */
  containsFile(absPosix: string): boolean;
  /** WOULD this program's tsconfig glob include `absPosix` — independent of whether the file
   *  exists yet? Unlike `containsFile`/`isTracked` (both existence-gated), this answers the glob
   *  question for a not-yet-created move/extract DEST, so the program that owns the dest joins the
   *  cross-program write gate and typechecks the moved file under ITS compilerOptions (membership.ts). */
  mayContain(absPosix: string): boolean;
  /** Apply a changed set; returns `true` when the change was structural for THIS program (a
   *  tracked file added/removed → the file list was re-globbed). */
  reindex(changed: readonly RepoRelPath[]): boolean;
  /** This program's monotonic version (bumps on every reindex/overlay) — folds into the host's
   *  aggregate freshness fingerprint. */
  version(): number;
  /** Best-effort patched-TS-fork LS (§4 rescue) over the SAME state, lazily built + cached. */
  rescueService(): ts.LanguageService | undefined;
  setOverlay(entries: readonly OverlayEntry[], removed?: readonly RepoRelPath[]): void;
  clearOverlay(): void;
  withMergedOverlay<T>(
    entries: readonly OverlayEntry[],
    removed: readonly RepoRelPath[],
    fn: () => T,
  ): T;
  dispose(): void;
}

/** Build a single-program LS over `configPath`. The stock service shares `registry` with the
 *  host's other programs (the tsserver dedup: files common to two configs parse once — bounded by
 *  program count, not free; a config that changes target/module/jsx buckets separately). The §4
 *  rescue fork keeps its OWN registry — the two namespaces must never cross-feed. */
export function createSingleProgram(
  root: string,
  configPath: string | undefined,
  label: string,
  registry: ts.DocumentRegistry,
  /** Repo-relative posix paths the project's `.gitignore` declares junk (host-memoized, computed
   *  ONCE per structural reindex — §19). Complements the name-based §10 set applied here; together
   *  they keep a loose tsconfig `include` from indexing build output / nested VCS checkouts as
   *  project symbols (the never-lie file-set fix). */
  ignored: () => ReadonlySet<string>,
): SingleProgram {
  let files = new Map<string, { version: number }>(); // abs posix → version
  let version = 1;
  const overlay = new Overlay();

  const configDir = configPath !== undefined ? path.dirname(configPath) : root;
  let parsed: ts.ParsedCommandLine;
  let membership: (absPosix: string) => boolean;
  const loadFileList = (): void => {
    parsed = parseConfig(root, configPath); // (re-)glob: picks up added/removed files
    membership = buildMembership(parsed, configDir, root); // glob predicate, rebuilt on re-glob
    const ignoredJunk = ignored(); // host-memoized: one git call per structural reindex (§19)
    const rootPrefix = `${toPosix(root)}/`;
    const next = new Map<string, { version: number }>();
    for (const abs of parsed.fileNames.map(toPosix)) {
      if (abs.includes('/node_modules/')) continue;
      // §10 file-set honesty: exclude build output / nested VCS checkouts / agent state (the
      // name-based set — the reliable excluder for a nested `.claude/worktrees` whole-tree copy the
      // outer `.gitignore` can't see across the working-tree boundary) AND anything the project's
      // own `.gitignore` declares junk (the git set — arbitrary main-tree `generated/`/`coverage/`
      // dirs no fixed name covers). Without this a loose `include:['**/*']` surfaces a minified
      // bundle as a symbol and phantom-doubles a real declaration (find_usages → 'ambiguous'). A
      // transitively-IMPORTED file is unaffected — TS still resolves an import INTO an excluded
      // path; only ROOT-globbed junk that nothing imports drops out.
      // Scoped to files UNDER the root: a file outside it isn't THIS repo's junk (and can't be in
      // the repo-relative git-ignored set), and running the name-segment check on its absolute path
      // could false-match an ancestor dir (`/home/me/build/…`) — the hazard hasIgnoredDirSegment warns of.
      if (abs.startsWith(rootPrefix)) {
        const rel = abs.slice(rootPrefix.length);
        if (hasIgnoredDirSegment(rel) || ignoredJunk.has(rel)) continue;
      }
      next.set(abs, files.get(abs) ?? { version: 1 });
    }
    files = next;
    version++;
  };
  loadFileList();

  const makeServicesHost = (tsm: typeof ts): ts.LanguageServiceHost => ({
    getScriptFileNames: () =>
      [...new Set([...files.keys(), ...overlay.keys()])].filter((f) => !overlay.isRemoved(f)),
    getScriptVersion: (fileName) => {
      const posix = toPosix(fileName);
      const over = overlay.get(posix);
      if (over !== undefined) return `o${over.version}`;
      return String(files.get(posix)?.version ?? 1);
    },
    getScriptSnapshot: (fileName) => {
      const posix = toPosix(fileName);
      if (overlay.isRemoved(posix)) return undefined;
      const over = overlay.get(posix);
      if (over !== undefined) return tsm.ScriptSnapshot.fromString(over.content);
      try {
        return tsm.ScriptSnapshot.fromString(readFileSync(fileName, 'utf8'));
      } catch {
        return undefined;
      }
    },
    getCurrentDirectory: () => root,
    getCompilationSettings: () => parsed.options, // cached — never re-parse on the hot path
    getDefaultLibFileName: (options) => tsm.getDefaultLibFilePath(options),
    fileExists: (fileName) => {
      const posix = toPosix(fileName);
      if (overlay.isRemoved(posix)) return false;
      return overlay.has(posix) || tsm.sys.fileExists(fileName);
    },
    readFile: (fileName, encoding) => {
      const posix = toPosix(fileName);
      if (overlay.isRemoved(posix)) return undefined;
      const over = overlay.get(posix);
      return over !== undefined ? over.content : tsm.sys.readFile(fileName, encoding);
    },
    readDirectory: tsm.sys.readDirectory,
    directoryExists: (dir) => overlay.hasDirectory(toPosix(dir)) || tsm.sys.directoryExists(dir),
    getDirectories: tsm.sys.getDirectories,
    getProjectVersion: () => String(version),
    // Canonicalize symlinks exactly like `tsc`/`createProgram` (`realpath: sys.realpath`); a
    // LanguageServiceHost that omits it loads a pnpm package under two paths and its types stop
    // unifying (ls-host-symlink.test.ts). A synthetic overlay/removed path realpaths to itself.
    realpath: (fileName) => {
      try {
        return tsm.sys.realpath ? tsm.sys.realpath(fileName) : fileName;
      } catch {
        return fileName;
      }
    },
  });

  const service = ts.createLanguageService(makeServicesHost(ts), registry);

  // Rescue LS — `undefined` = not yet attempted, `null` = attempted & unavailable, else built.
  let rescue: ts.LanguageService | null | undefined;
  const rescueService = (): ts.LanguageService | undefined => {
    if (rescue !== undefined) return rescue ?? undefined;
    const fix = loadRescueTs();
    if (fix === undefined) {
      rescue = null;
      return undefined;
    }
    rescue = fix.createLanguageService(makeServicesHost(fix), fix.createDocumentRegistry());
    return rescue;
  };

  return {
    service,
    configPath,
    label,
    getProgram: () => service.getProgram(),
    fileNames: () => [...files.keys()],
    isTracked: (absPosix) => files.has(absPosix),
    containsFile: (absPosix) => service.getProgram()?.getSourceFile(absPosix) !== undefined,
    mayContain: (absPosix) => membership(absPosix),
    reindex(changed) {
      let structural = false;
      for (const rel of changed) {
        const abs = toPosix(path.join(root, rel));
        const entry = files.get(abs);
        if (entry !== undefined) entry.version++;
        else if (isTsLike(abs))
          structural = true; // a new/renamed source file (maybe ours)
        // A tsconfig change re-globs the file list AND re-reads compilerOptions: an edited
        // `include`/`exclude` changes which files this program owns, and an edited `strict`/`paths`/…
        // changes how it type-checks them — both stale until `loadFileList` re-parses. We trigger on
        // ANY `tsconfig*.json`-named path in the changed set (not just our own `configPath`), which
        // also catches a `tsconfig*.json`-named `extends` parent. An `extends` target with a
        // NON-tsconfig basename (e.g. `./base.json`, `configs/strict.json`) is NOT detected → stale
        // until an unrelated source add/remove (docs/backlog.md). The re-glob stays §19-bounded — it
        // runs only here, on the reindex changed set, never on the LS hot path (`getCompilationSettings`).
        else if (isTsconfigBasename(abs.slice(abs.lastIndexOf('/') + 1))) structural = true;
        // A `.gitignore` edit changes which files are junk (the §10 git-ignore exclusion in
        // `loadFileList`): un-ignoring `generated/` must re-glob those files back IN. The host cleared
        // the memoized ignore set on this reindex, but only a re-glob re-applies it — so treat any
        // `.gitignore` in the changed set as structural (else the un-ignored files stay dropped until
        // an unrelated source add/remove — a silent completeness gap, §3.4).
        else if (abs.slice(abs.lastIndexOf('/') + 1) === '.gitignore') structural = true;
      }
      version++;
      if (structural) loadFileList();
      return structural;
    },
    version: () => version,
    rescueService,
    setOverlay(entries, removed = []) {
      overlay.set(
        entries.map((e) => ({ abs: toPosix(e.abs), content: e.content })),
        removed.map((r) => toPosix(path.join(root, r))),
      );
      version++;
    },
    clearOverlay() {
      overlay.clear();
      version++;
    },
    withMergedOverlay(entries, removed, fn) {
      const snap = overlay.snapshot();
      overlay.merge(
        entries.map((e) => ({ abs: toPosix(e.abs), content: e.content })),
        removed.map((r) => toPosix(path.join(root, r))),
      );
      version++;
      try {
        return fn();
      } finally {
        overlay.set(snap.entries, snap.removed);
        version++;
      }
    },
    dispose() {
      service.dispose();
      if (rescue !== null && rescue !== undefined) rescue.dispose();
    },
  };
}

/** Load the patched TS fork (§4 rescue) from codemaster's OWN node_modules — only when it loads
 *  AND its major matches the bundled TS (a mismatch means the fork's edits may not align, so we
 *  decline; an unavailable rescue is an honest failure, never a wrong edit). */
function loadRescueTs(): typeof ts | undefined {
  try {
    const fix = createRequire(import.meta.url)(
      '@cevek/typescript-extract-refactor-fix',
    ) as typeof ts;
    if (typeof fix.createLanguageService !== 'function' || typeof fix.version !== 'string') {
      return undefined;
    }
    if (fix.version.split('.')[0] !== ts.version.split('.')[0]) return undefined;
    return fix;
  } catch {
    return undefined;
  }
}

function parseConfig(root: string, configPath: string | undefined): ts.ParsedCommandLine {
  if (configPath === undefined) {
    return {
      options: { allowJs: true, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 },
      fileNames: ts.sys
        .readDirectory(root, ['.ts', '.tsx', '.js', '.jsx'], ['node_modules', 'dist', 'build'], [])
        .map(toPosix),
      errors: [],
    };
  }
  const text = ts.readConfigFile(configPath, ts.sys.readFile);
  return ts.parseJsonConfigFileContent(
    text.config ?? {},
    ts.sys,
    path.dirname(configPath),
    undefined,
    configPath,
  );
}

function isTsLike(p: string): boolean {
  return /\.(ts|tsx|js|jsx|mts|cts)$/.test(p);
}
